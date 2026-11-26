import { Inject, Injectable } from "@nestjs/common";
import { RAG_CONFIG } from "../rag.constants.js";
import type { RagConfig } from "../rag.config.js";
import type { RetrievedChunk } from "../types/rag.types.js";

export interface ConfidenceAssessment {
  /** Best cosine similarity among retrieved chunks (0 when nothing was retrieved). */
  confidenceScore: number;
  threshold: number;
  /** Chunks at or above the threshold, in ranked order. */
  accepted: RetrievedChunk[];
  rejected: RetrievedChunk[];
}

@Injectable()
export class ConfidenceService {
  constructor(@Inject(RAG_CONFIG) private readonly config: RagConfig) {}

  /**
   * First guardrail layer: similarity gate. Passing it is necessary but not sufficient; the evidence verifier
   * must still confirm the passages actually answer the question.
   */
  assess(ranked: RetrievedChunk[]): ConfidenceAssessment {
    const threshold = this.config.minSimilarity;
    const accepted = ranked.filter((c) => c.similarity >= threshold);
    const rejected = ranked.filter((c) => c.similarity < threshold);
    const confidenceScore = ranked.reduce((m, c) => Math.max(m, c.similarity), 0);
    return { confidenceScore, threshold, accepted, rejected };
  }
}
