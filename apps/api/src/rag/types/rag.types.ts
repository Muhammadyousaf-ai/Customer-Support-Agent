import type { BillingPeriod, PolicyCategory, Tier } from "@support-ai/contracts";

export interface ParsedDocument {
  fileName: string;
  title: string;
  category: PolicyCategory;
  version: string;
  /** Markdown body without frontmatter. */
  body: string;
  /** sha256 of the raw file. */
  checksum: string;
}

export interface ChunkDraft {
  chunkIndex: number;
  heading: string;
  /** Text stored and shown to the agent. */
  content: string;
  /** Text embedded: document title + heading + content, so headings carry semantic weight. */
  embedText: string;
  applicableTiers: Tier[];
  contractTypes: BillingPeriod[];
  metadata: Record<string, unknown>;
}

export interface NewChunk extends ChunkDraft {
  embedding: number[];
}

export interface NewDocument {
  title: string;
  category: PolicyCategory;
  content: string;
  version: string;
  checksum: string;
}

export interface StoredDocumentRef {
  id: string;
  checksum: string;
  embeddingModel: string | null;
}

export interface DocumentSummary {
  id: string;
  title: string;
  category: PolicyCategory;
  version: string;
  checksum: string;
  chunkCount: number;
  createdAt: string;
}

export interface RetrievedChunk {
  id: string;
  documentId: string;
  document: string;
  documentTitle: string;
  category: PolicyCategory;
  version: string;
  heading: string;
  content: string;
  applicableTiers: Tier[];
  contractTypes: BillingPeriod[];
  chunkIndex: number;
  /** Cosine similarity, 1 - cosine distance. */
  similarity: number;
}

export interface SearchFilters {
  tier?: Tier;
  contractType?: BillingPeriod;
}

export interface DocumentStore {
  findDocumentByTitle(title: string): Promise<StoredDocumentRef | null>;
  replaceDocument(doc: NewDocument, chunks: NewChunk[]): Promise<{ documentId: string; replaced: boolean }>;
  searchChunks(params: {
    embedding: number[];
    embeddingModel: string;
    filters: SearchFilters;
    limit: number;
  }): Promise<RetrievedChunk[]>;
  listDocuments(): Promise<DocumentSummary[]>;
  /** Removes the document and (by cascade) all its chunks/embeddings. */
  deleteDocumentByTitle(title: string): Promise<boolean>;
  stats(): Promise<{ documents: number; chunks: number; pgvector: boolean }>;
}

export interface EmbedResult {
  vectors: number[][];
  tokens: number;
}
export interface Embedder {
  readonly name: "openai" | "local";
  readonly model: string;
  embed(texts: string[]): Promise<EmbedResult>;
}

export interface VerificationResult {
  method: "llm" | "heuristic";
  supported: boolean;
  reason: string;
  inputTokens: number;
  outputTokens: number;
}
export interface EvidenceVerifier {
  verify(input: { query: string; filters: SearchFilters; sources: RetrievedChunk[] }): Promise<VerificationResult>;
}

export interface RagHealth {
  status: "ok" | "degraded" | "down";
  documents: number;
  chunks: number;
  pgvector: boolean;
  embeddings: { provider: string; model: string };
  verifier: string;
  threshold: number;
}
