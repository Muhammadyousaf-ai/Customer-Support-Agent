import { openAiPost } from "../../providers/openai-http.js";
import { EMBEDDING_DIMENSIONS } from "../rag.constants.js";
import type { Embedder, EmbedResult } from "../types/rag.types.js";

interface OpenAiEmbeddingResponse {
  data: Array<{ index: number; embedding: number[] }>;
  usage?: { prompt_tokens: number; total_tokens: number };
}

const BATCH_SIZE = 64;

export class OpenAiEmbedder implements Embedder {
  readonly name = "openai" as const;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async embed(texts: string[]): Promise<EmbedResult> {
    const vectors: number[][] = [];
    let tokens = 0;
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const input = texts.slice(i, i + BATCH_SIZE);
      const res = await openAiPost<OpenAiEmbeddingResponse>(
        "/embeddings",
        { model: this.model, input, dimensions: EMBEDDING_DIMENSIONS },
        { apiKey: this.apiKey },
      );
      for (const d of [...res.data].sort((a, b) => a.index - b.index)) vectors.push(d.embedding);
      tokens += res.usage?.total_tokens ?? 0;
    }
    if (vectors.length !== texts.length || vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
      throw new Error(`Embedding response did not match ${texts.length} x ${EMBEDDING_DIMENSIONS}`);
    }
    return { vectors, tokens };
  }
}
