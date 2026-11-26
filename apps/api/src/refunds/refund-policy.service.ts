import { Inject, Injectable } from "@nestjs/common";
import type { BillingPeriod, Tier } from "@support-ai/contracts";
import { RagService } from "../rag/rag.service.js";

export interface RefundPolicyLookup {
  available: boolean;
  sources: Array<{ document: string; heading: string; similarity: number }>;
}

@Injectable()
export class RefundPolicyService {
  constructor(@Inject(RagService) private readonly rag: RagService) {}

  /**
   * Confirms a grounded, applicable refund policy exists for this tier and contract (Phase 2 RAG).
   * The query is built here from trusted records, never from LLM text. Anything not `grounded` counts as
   * "policy unavailable", which the rules turn into an escalation.
   */
  async resolve(tier: Tier, contractType: BillingPeriod | "custom"): Promise<RefundPolicyLookup> {
    // Tier and contract are applied as metadata filters; repeating them in the query text only pulls in
    // unrelated chunks (e.g. cancellation rules for "monthly subscription"), so the query stays on refund content.
    const res = await this.rag.search({
      query: "refund policy eligibility, refund window and automated refund limit",
      tier,
      ...(contractType === "custom" ? {} : { contractType }),
      topK: 3,
    });
    return {
      available: res.status === "grounded",
      sources: res.sources.map((s) => ({ document: s.document, heading: s.heading, similarity: s.similarity })),
    };
  }
}
