import type { Env } from "../config/env.js";

export interface RagConfig {
  embeddingsProvider: "openai" | "local";
  embeddingModel: string;
  verifier: "llm" | "heuristic";
  /** Cosine similarity a chunk must reach to count as evidence. */
  minSimilarity: number;
  chatModel: string;
  openAiApiKey: string;
  knowledgeBaseDir: string;
}

/**
 * Starting thresholds, NOT calibrated truths. Calibrate against evaluations/retrieval-cases.json
 * (`pnpm --filter api rag:eval -- --sweep`) whenever the embedding model changes.
 */
export const DEFAULT_MIN_SIMILARITY = { openai: 0.4, local: 0.18 } as const;

export function resolveRagConfig(env: Env): RagConfig {
  const embeddingsProvider = env.EMBEDDINGS_PROVIDER ?? (env.OPENAI_API_KEY ? "openai" : "local");
  if (embeddingsProvider === "openai" && !env.OPENAI_API_KEY) {
    throw new Error("EMBEDDINGS_PROVIDER=openai requires OPENAI_API_KEY");
  }
  const verifier = env.RAG_VERIFIER ?? (embeddingsProvider === "openai" ? "llm" : "heuristic");
  if (verifier === "llm" && !env.OPENAI_API_KEY) throw new Error("RAG_VERIFIER=llm requires OPENAI_API_KEY");
  return {
    embeddingsProvider,
    embeddingModel: embeddingsProvider === "openai" ? env.OPENAI_EMBEDDING_MODEL : "local-hash-1536-v1",
    verifier,
    minSimilarity: env.RETRIEVAL_MIN_SIMILARITY ?? DEFAULT_MIN_SIMILARITY[embeddingsProvider],
    chatModel: env.OPENAI_CHAT_MODEL,
    openAiApiKey: env.OPENAI_API_KEY,
    knowledgeBaseDir: env.KNOWLEDGE_BASE_DIR,
  };
}
