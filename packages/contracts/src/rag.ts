import { z } from "zod";
import { BILLING_PERIODS, TIERS, type BillingPeriod, type PolicyCategory, type Tier } from "./policy.js";

export const ragSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  tier: z.enum(TIERS).optional(),
  contractType: z.enum(BILLING_PERIODS).optional(),
  topK: z.number().int().min(1).max(10).default(5),
});
export type RagSearchRequest = z.input<typeof ragSearchRequestSchema>;

export const RAG_STATUSES = [
  "grounded",
  "insufficient_evidence",
  "no_applicable_policy",
  "retrieval_failed",
] as const;
export type RagStatus = (typeof RAG_STATUSES)[number];

export interface RagSource {
  chunkId: string;
  document: string;
  documentTitle: string;
  category: PolicyCategory;
  policyVersion: string;
  heading: string;
  content: string;
  similarity: number;
  /** Applicability breadth: "tier-specific" outranks "general" when similarity is close. */
  specificity: "general" | "tier-specific" | "contract-specific" | "tier-and-contract-specific";
  applicableTiers: Tier[];
  contractTypes: BillingPeriod[];
}

export interface RagSearchResponse {
  status: RagStatus;
  confidenceScore: number;
  evidenceVerified: boolean;
  requiresEscalation: boolean;
  escalationReason?: string;
  /** Evidence the agent may use: passed the similarity threshold and (when grounded) secondary verification. */
  sources: RagSource[];
  /** Retrieved but below the similarity threshold. For inspection only; never answer from these. */
  rejected: RagSource[];
  verification?: { method: "llm" | "heuristic"; supported: boolean; reason: string };
  appliedFilters: { tier?: Tier; contractType?: BillingPeriod };
  threshold: number;
  providers: { embeddings: string; embeddingModel: string };
  metrics: {
    embeddingLatencyMs: number;
    retrievalLatencyMs: number;
    verificationLatencyMs: number;
    totalLatencyMs: number;
  };
  usage: { embeddingTokens: number; verificationInputTokens: number; verificationOutputTokens: number };
}

export interface RagIngestResult {
  file: string;
  status: "ingested" | "updated" | "skipped_duplicate" | "failed";
  chunks: number;
  error?: string;
}
export interface RagIngestReport {
  embeddingModel: string;
  embeddingTokens: number;
  results: RagIngestResult[];
}
