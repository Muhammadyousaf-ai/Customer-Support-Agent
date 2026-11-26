import { describe, expect, it } from "vitest";
import { ConfidenceService } from "../confidence/confidence.service.js";
import { HeuristicEvidenceVerifier } from "../confidence/heuristic-verifier.js";
import { RankingService, specificityOf } from "../retrieval/ranking.service.js";
import type { RetrievedChunk } from "../types/rag.types.js";
import { testConfig } from "./helpers.js";

const chunk = (over: Partial<RetrievedChunk>): RetrievedChunk => ({
  id: "c", documentId: "d", document: "refund-policy.md", documentTitle: "Refund Policy", category: "refund", version: "1",
  heading: "H", content: "text", applicableTiers: ["free", "basic", "pro", "enterprise"], contractTypes: ["monthly", "annual"],
  chunkIndex: 0, similarity: 0.5, ...over,
});

describe("ranking", () => {
  it("classifies specificity", () => {
    expect(specificityOf(chunk({}))).toBe("general");
    expect(specificityOf(chunk({ applicableTiers: ["pro"] }))).toBe("tier-specific");
    expect(specificityOf(chunk({ applicableTiers: ["pro"], contractTypes: ["monthly"] }))).toBe("tier-and-contract-specific");
  });
  it("puts a tier-specific exception ahead of a general rule on near-ties (conflicting policies)", () => {
    const general = chunk({ id: "general", similarity: 0.52, chunkIndex: 0 });
    const enterprise = chunk({ id: "enterprise", similarity: 0.5, applicableTiers: ["enterprise"], chunkIndex: 3 });
    expect(new RankingService().rank([general, enterprise]).map((c) => c.id)).toEqual(["enterprise", "general"]);
  });
  it("does not let specificity override a clearly more relevant chunk", () => {
    const relevant = chunk({ id: "relevant", similarity: 0.7 });
    const specific = chunk({ id: "specific", similarity: 0.4, applicableTiers: ["pro"], contractTypes: ["monthly"] });
    expect(new RankingService().rank([specific, relevant])[0]!.id).toBe("relevant");
  });
});

describe("confidence gate", () => {
  const svc = new ConfidenceService({ ...testConfig, minSimilarity: 0.4 });
  it("splits accepted and rejected around the threshold and reports the best similarity", () => {
    const r = svc.assess([chunk({ id: "a", similarity: 0.62 }), chunk({ id: "b", similarity: 0.4 }), chunk({ id: "c", similarity: 0.39 })]);
    expect(r.accepted.map((c) => c.id)).toEqual(["a", "b"]);
    expect(r.rejected.map((c) => c.id)).toEqual(["c"]);
    expect(r.confidenceScore).toBe(0.62);
  });
  it("handles no results", () => {
    expect(svc.assess([])).toMatchObject({ confidenceScore: 0, accepted: [], rejected: [] });
  });
});

describe("heuristic evidence verifier", () => {
  const v = new HeuristicEvidenceVerifier();
  const refund = chunk({ heading: "Monthly subscription refunds", content: "Monthly subscriptions can be refunded within seven days." });
  it("accepts evidence that covers the question's subject", async () => {
    expect((await v.verify({ query: "Can I get a refund on my monthly plan?", filters: {}, sources: [refund] })).supported).toBe(true);
  });
  it("rejects evidence that merely sits nearby", async () => {
    expect((await v.verify({ query: "Who won the football game?", filters: {}, sources: [refund] })).supported).toBe(false);
  });
});
