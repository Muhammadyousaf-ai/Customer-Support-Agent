import type { Env } from "../../config/env.js";
import { loadEnv } from "../../config/env.js";
import { ChunkingService } from "../chunking/chunking.service.js";
import { ConfidenceService } from "../confidence/confidence.service.js";
import { HeuristicEvidenceVerifier } from "../confidence/heuristic-verifier.js";
import { EmbeddingService } from "../embeddings/embedding.service.js";
import { LocalHashEmbedder } from "../embeddings/local-hash.embedder.js";
import { IngestionService } from "../ingestion/ingestion.service.js";
import type { RagConfig } from "../rag.config.js";
import { RagService } from "../rag.service.js";
import { RankingService } from "../retrieval/ranking.service.js";
import { RetrievalService } from "../retrieval/retrieval.service.js";
import type {
  DocumentStore, DocumentSummary, Embedder, EvidenceVerifier, NewChunk, NewDocument, RetrievedChunk, StoredDocumentRef,
} from "../types/rag.types.js";

export const testConfig: RagConfig = {
  embeddingsProvider: "local",
  embeddingModel: "local-hash-1536-v1",
  verifier: "heuristic",
  minSimilarity: 0.18,
  chatModel: "none",
  openAiApiKey: "",
  knowledgeBaseDir: "../../knowledge-base",
};

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

/** In-memory DocumentStore with the same filtering semantics as the SQL repository. */
export class InMemoryStore implements DocumentStore {
  docs = new Map<string, { id: string; doc: NewDocument; chunks: NewChunk[] }>();
  replaceCalls = 0;
  failSearch = false;

  async findDocumentByTitle(title: string): Promise<StoredDocumentRef | null> {
    const d = this.docs.get(title);
    if (!d) return null;
    return { id: d.id, checksum: d.doc.checksum, embeddingModel: (d.chunks[0]?.metadata.embeddingModel as string) ?? null };
  }
  async replaceDocument(doc: NewDocument, chunks: NewChunk[]) {
    this.replaceCalls++;
    const existing = this.docs.get(doc.title);
    const id = existing?.id ?? `doc-${this.docs.size + 1}`;
    this.docs.set(doc.title, { id, doc, chunks });
    return { documentId: id, replaced: Boolean(existing) };
  }
  async deleteDocumentByTitle(title: string) {
    return this.docs.delete(title);
  }
  async searchChunks(p: Parameters<DocumentStore["searchChunks"]>[0]): Promise<RetrievedChunk[]> {
    if (this.failSearch) throw new Error("db down");
    const out: RetrievedChunk[] = [];
    for (const { id, doc, chunks } of this.docs.values()) {
      for (const c of chunks) {
        if (c.metadata.embeddingModel !== p.embeddingModel) continue;
        if (p.filters.tier && !c.applicableTiers.includes(p.filters.tier)) continue;
        if (p.filters.contractType && !c.contractTypes.includes(p.filters.contractType)) continue;
        out.push({
          id: `${id}:${c.chunkIndex}`, documentId: id, document: String(c.metadata.fileName), documentTitle: doc.title,
          category: doc.category, version: doc.version, heading: c.heading, content: c.content,
          applicableTiers: c.applicableTiers, contractTypes: c.contractTypes, chunkIndex: c.chunkIndex,
          similarity: cosine(p.embedding, c.embedding),
        });
      }
    }
    return out.sort((a, b) => b.similarity - a.similarity).slice(0, p.limit);
  }
  async listDocuments(): Promise<DocumentSummary[]> {
    return [...this.docs.values()].map(({ id, doc, chunks }) => ({
      id, title: doc.title, category: doc.category, version: doc.version, checksum: doc.checksum,
      chunkCount: chunks.length, createdAt: new Date(0).toISOString(),
    }));
  }
  async stats() {
    return { documents: this.docs.size, chunks: [...this.docs.values()].reduce((n, d) => n + d.chunks.length, 0), pgvector: true };
  }
}

export function buildRag(opts: {
  store?: InMemoryStore;
  embedder?: Embedder;
  verifier?: EvidenceVerifier;
  env?: Partial<NodeJS.ProcessEnv>;
  config?: Partial<RagConfig>;
} = {}) {
  const store = opts.store ?? new InMemoryStore();
  const config = { ...testConfig, ...opts.config };
  const env: Env = loadEnv({ ...opts.env });
  const embeddings = new EmbeddingService(opts.embedder ?? new LocalHashEmbedder());
  const chunking = new ChunkingService();
  const ranking = new RankingService();
  const retrieval = new RetrievalService(store, ranking, config);
  const confidence = new ConfidenceService(config);
  const verifier = opts.verifier ?? new HeuristicEvidenceVerifier();
  const ingestion = new IngestionService(store, chunking, embeddings, config);
  const rag = new RagService(embeddings, retrieval, confidence, verifier, store, config, env);
  return { store, ingestion, rag, embeddings, chunking, ranking, confidence, config };
}
