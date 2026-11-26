import { Inject, Injectable } from "@nestjs/common";
import { EMBEDDER } from "../rag.constants.js";
import type { Embedder, EmbedResult } from "../types/rag.types.js";

@Injectable()
export class EmbeddingService {
  constructor(@Inject(EMBEDDER) private readonly embedder: Embedder) {}

  get provider() {
    return this.embedder.name;
  }
  get model() {
    return this.embedder.model;
  }

  async embedQuery(query: string): Promise<{ vector: number[]; tokens: number }> {
    const { vectors, tokens } = await this.embedder.embed([query]);
    return { vector: vectors[0]!, tokens };
  }

  embedDocuments(texts: string[]): Promise<EmbedResult> {
    return this.embedder.embed(texts);
  }
}
