import { describe, expect, it } from "vitest";
import { pool } from "../../database/pool.js";
import { DocumentRepository } from "../repositories/document.repository.js";
import { testConfig } from "./helpers.js";
import { RetrievalService } from "../retrieval/retrieval.service.js";
import { RankingService } from "../retrieval/ranking.service.js";
import { EmbeddingService } from "../embeddings/embedding.service.js";
import { LocalHashEmbedder } from "../embeddings/local-hash.embedder.js";
import { ChunkingService } from "../chunking/chunking.service.js";
import { IngestionService } from "../ingestion/ingestion.service.js";
import { ConfidenceService } from "../confidence/confidence.service.js";
import { HeuristicEvidenceVerifier } from "../confidence/heuristic-verifier.js";
import { RagService } from "../rag.service.js";
import { loadEnv } from "../../config/env.js";

const dbUp = await pool.query("select 1 from document_chunks limit 1").then(() => true, () => false);

/** Runs against the real Postgres + pgvector (skipped when the database / migrations are unavailable). */
describe.skipIf(!dbUp)("pgvector integration", () => {
  const store = new DocumentRepository(pool);
  const embeddings = new EmbeddingService(new LocalHashEmbedder());
  const ingestion = new IngestionService(store, new ChunkingService(), embeddings, testConfig);
  const rag = new RagService(
    embeddings,
    new RetrievalService(store, new RankingService(), testConfig),
    new ConfidenceService(testConfig),
    new HeuristicEvidenceVerifier(),
    store,
    testConfig,
    loadEnv({}),
  );

  it("ingests the knowledge base idempotently", async () => {
    await ingestion.ingestDirectory();
    const again = await ingestion.ingestDirectory();
    expect(again.results.every((r) => r.status === "skipped_duplicate")).toBe(true);
    const docs = await rag.listDocuments();
    expect(docs.map((d) => d.title)).toContain("Refund Policy");
    const { rows } = await pool.query("select count(*)::int as n from documents");
    expect(rows[0].n).toBe(docs.length);
  });

  it("filters by tier and contract type in SQL and returns cosine similarity in [0,1]", async () => {
    const res = await rag.search({ query: "refund", tier: "enterprise", contractType: "annual", topK: 10 });
    const all = [...res.sources, ...res.rejected];
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) {
      expect(s.applicableTiers).toContain("enterprise");
      expect(s.contractTypes).toContain("annual");
      expect(s.similarity).toBeGreaterThanOrEqual(-1);
      expect(s.similarity).toBeLessThanOrEqual(1);
    }
  });

  it("grounds a supported question and escalates an unsupported one", async () => {
    const ok = await rag.search({ query: "Can I get a refund for my Pro subscription?", tier: "pro", contractType: "monthly", topK: 5 });
    expect(ok.status).toBe("grounded");
    const no = await rag.search({ query: "What is a good recipe for pasta carbonara?", topK: 5 });
    expect(no.requiresEscalation).toBe(true);
  });

  it("ignores chunks embedded with a different model", async () => {
    const other = new RetrievalService(store, new RankingService(), { ...testConfig, embeddingModel: "some-other-model" });
    expect(await other.retrieve(Array.from({ length: 1536 }, () => 0.02), {}, 5)).toEqual([]);
  });
});
