import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { EvidenceVerifier } from "../types/rag.types.js";
import { buildRag, InMemoryStore } from "./helpers.js";

const kb = resolve(process.cwd(), "../../knowledge-base");
const store = new InMemoryStore();

beforeAll(async () => {
  const { ingestion } = buildRag({ store });
  for (const f of readdirSync(kb).filter((n) => n.endsWith(".md"))) {
    const r = await ingestion.ingestFile(f, readFileSync(resolve(kb, f), "utf8"));
    expect(r.result.status).toBe("ingested");
  }
});

describe("RagService (real knowledge base, in-memory store)", () => {
  it("grounds a supported question and returns scores, evidence and metrics", async () => {
    const res = await buildRag({ store }).rag.search({ query: "Can I get a refund for my Pro subscription?", tier: "pro", contractType: "monthly", topK: 5 });
    expect(res).toMatchObject({ status: "grounded", evidenceVerified: true, requiresEscalation: false });
    expect(res.sources[0]).toMatchObject({ document: "refund-policy.md", heading: "Monthly subscription refunds" });
    expect(res.confidenceScore).toBeGreaterThanOrEqual(res.threshold);
    expect(res.metrics.totalLatencyMs).toBeGreaterThanOrEqual(0);
    expect(res.providers.embeddings).toBe("local");
  });

  it("escalates out-of-scope questions with a structured result", async () => {
    const res = await buildRag({ store }).rag.search({ query: "Who won the football game last night?", topK: 5 });
    expect(res).toMatchObject({ status: "insufficient_evidence", requiresEscalation: true, evidenceVerified: false, sources: [] });
    expect(res.escalationReason).toBeTruthy();
    expect(res.rejected.length).toBeGreaterThan(0);
  });

  it("never returns a chunk that does not apply to the customer's tier", async () => {
    const { rag } = buildRag({ store });
    for (const tier of ["free", "basic", "pro", "enterprise"] as const) {
      const res = await rag.search({ query: "refund policy", tier, topK: 10 });
      for (const s of [...res.sources, ...res.rejected]) expect(s.applicableTiers).toContain(tier);
    }
  });

  it("never returns a chunk that does not apply to the contract type", async () => {
    const res = await buildRag({ store }).rag.search({ query: "refund policy", tier: "pro", contractType: "annual", topK: 10 });
    for (const s of [...res.sources, ...res.rejected]) expect(s.contractTypes).toContain("annual");
    expect([...res.sources, ...res.rejected].some((s) => s.heading === "Monthly subscription refunds")).toBe(false);
  });

  it("gives an Enterprise customer the Enterprise exception ahead of the general rule (conflicting policies)", async () => {
    const res = await buildRag({ store }).rag.search({ query: "How long is the refund window for my enterprise contract?", tier: "enterprise", topK: 5 });
    expect(res.status).toBe("grounded");
    expect(res.sources[0]!.heading).toBe("Enterprise refund exceptions");
    const general = res.sources.findIndex((s) => s.heading === "General refund rules");
    if (general >= 0) expect(general).toBeGreaterThan(0);
  });

  it("returns no_applicable_policy when filters leave nothing", async () => {
    const empty = buildRag({ store: new InMemoryStore() });
    const res = await empty.rag.search({ query: "refund", tier: "pro", topK: 5 });
    expect(res).toMatchObject({ status: "no_applicable_policy", requiresEscalation: true });
  });

  it("escalates when the secondary verifier rejects evidence that passed the similarity gate", async () => {
    const verifier: EvidenceVerifier = { verify: async () => ({ method: "llm", supported: false, reason: "passage is silent on transfers", inputTokens: 40, outputTokens: 8 }) };
    const res = await buildRag({ store, verifier }).rag.search({ query: "Can I get a refund for my Pro subscription?", tier: "pro", topK: 5 });
    expect(res).toMatchObject({ status: "insufficient_evidence", evidenceVerified: false, requiresEscalation: true, sources: [] });
    expect(res.verification).toMatchObject({ supported: false, reason: "passage is silent on transfers" });
    expect(res.usage).toMatchObject({ verificationInputTokens: 40, verificationOutputTokens: 8 });
  });

  describe("retrieval failures", () => {
    it("returns retrieval_failed (not an exception) when the store is down", async () => {
      const broken = new InMemoryStore();
      broken.failSearch = true;
      const res = await buildRag({ store: broken }).rag.search({ query: "refund", topK: 5 });
      expect(res).toMatchObject({ status: "retrieval_failed", requiresEscalation: true, evidenceVerified: false });
    });
    it("returns retrieval_failed when the embedding provider errors", async () => {
      const embedder = { name: "openai" as const, model: "m", embed: async () => { throw new Error("429"); } };
      expect((await buildRag({ store, embedder }).rag.search({ query: "refund", topK: 5 })).status).toBe("retrieval_failed");
    });
    it("honours the SIMULATE_FAILURE=retrieval demo switch", async () => {
      const res = await buildRag({ store, env: { SIMULATE_FAILURE: "retrieval" } }).rag.search({ query: "refund", topK: 5 });
      expect(res.status).toBe("retrieval_failed");
    });
  });

  it("reports health", async () => {
    expect(await buildRag({ store }).rag.health()).toMatchObject({ status: "ok", pgvector: true, embeddings: { provider: "local" } });
  });
});
