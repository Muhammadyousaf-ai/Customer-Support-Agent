import { Injectable } from "@nestjs/common";
import { BILLING_PERIODS, TIERS, type RagSource } from "@support-ai/contracts";
import type { RetrievedChunk } from "../types/rag.types.js";

/** Rank bonus for a fully specific chunk. Small on purpose: breaks near-ties, never overrides relevance. */
export const SPECIFICITY_BONUS = 0.03;

export function specificityOf(c: Pick<RetrievedChunk, "applicableTiers" | "contractTypes">): RagSource["specificity"] {
  const tierSpecific = c.applicableTiers.length < TIERS.length;
  const contractSpecific = c.contractTypes.length < BILLING_PERIODS.length;
  if (tierSpecific && contractSpecific) return "tier-and-contract-specific";
  if (tierSpecific) return "tier-specific";
  if (contractSpecific) return "contract-specific";
  return "general";
}

const SPECIFICITY_WEIGHT: Record<RagSource["specificity"], number> = {
  general: 0,
  "contract-specific": 0.5,
  "tier-specific": 0.75,
  "tier-and-contract-specific": 1,
};

@Injectable()
export class RankingService {
  /**
   * Orders by similarity plus a small specificity bonus, so when a general rule and a tier-specific exception
   * both match, the exception comes first (a signed-contract rule beats the generic one). `similarity` itself is
   * never altered.
   */
  rank(chunks: RetrievedChunk[]): RetrievedChunk[] {
    const score = (c: RetrievedChunk) => c.similarity + SPECIFICITY_BONUS * SPECIFICITY_WEIGHT[specificityOf(c)];
    return [...chunks].sort((a, b) => score(b) - score(a) || a.chunkIndex - b.chunkIndex);
  }
}
