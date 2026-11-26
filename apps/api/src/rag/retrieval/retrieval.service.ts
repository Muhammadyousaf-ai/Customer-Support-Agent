import { Inject, Injectable } from "@nestjs/common";
import { RankingService } from "./ranking.service.js";
import { DOCUMENT_STORE, RAG_CONFIG } from "../rag.constants.js";
import type { RagConfig } from "../rag.config.js";
import type { DocumentStore, RetrievedChunk, SearchFilters } from "../types/rag.types.js";

@Injectable()
export class RetrievalService {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(RankingService) private readonly ranking: RankingService,
    @Inject(RAG_CONFIG) private readonly config: RagConfig,
  ) {}

  /** Cosine search with tier/contract metadata filtering done in SQL, then specificity-aware ranking. */
  async retrieve(embedding: number[], filters: SearchFilters, topK: number): Promise<RetrievedChunk[]> {
    // Over-fetch so ranking has room to promote a more specific chunk that sits just below the cut.
    const candidates = await this.store.searchChunks({
      embedding,
      embeddingModel: this.config.embeddingModel,
      filters,
      limit: topK * 2,
    });
    return this.ranking.rank(candidates).slice(0, topK);
  }
}
