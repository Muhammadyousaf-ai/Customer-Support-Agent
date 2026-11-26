import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { ContractsService } from "../../contracts/contracts.service.js";
import { RagService } from "../../rag/rag.service.js";
import { SubscriptionsService } from "../../subscriptions/subscriptions.service.js";
import type { ToolDefinition, ToolExecutionContext } from "../registry/tool-definition.interface.js";
import { fail, ok } from "../types/tool-result.js";

const input = z.object({ query: z.string().trim().min(1).max(1000), topK: z.number().int().min(1).max(8).default(5) });
type Input = z.infer<typeof input>;

@Injectable()
export class SearchKnowledgeBaseTool implements ToolDefinition<Input> {
  readonly name = "search_knowledge_base";
  readonly description =
    "Search company support policies. Returns grounded evidence with similarity scores, or requiresEscalation=true when no policy supports an answer. Results are filtered to the verified customer's tier and contract automatically.";
  readonly inputSchema = input;
  readonly type = "retrieval" as const;
  readonly requiresIdentity = false;
  readonly timeoutMs = 15_000;
  readonly maxRetries = 1;

  constructor(
    @Inject(RagService) private readonly rag: RagService,
    @Inject(SubscriptionsService) private readonly subscriptions: SubscriptionsService,
    @Inject(ContractsService) private readonly contracts: ContractsService,
  ) {}

  async execute(i: Input, ctx: ToolExecutionContext) {
    // Tier and contract come from trusted records for the verified customer, never from tool arguments.
    let tier, contractType;
    if (ctx.identityVerified && ctx.customerId) {
      const [sub, contract] = await Promise.all([this.subscriptions.getForCustomer(ctx.customerId), this.contracts.getForCustomer(ctx.customerId)]);
      tier = sub?.tier;
      const t = contract?.type ?? sub?.billingPeriod;
      contractType = t === "monthly" || t === "annual" ? t : undefined;
    }
    const res = await this.rag.search({ query: i.query, topK: i.topK, ...(tier ? { tier } : {}), ...(contractType ? { contractType } : {}) });
    // retrieval_failed is a retryable infrastructure problem; everything else is a normal answer.
    if (res.status === "retrieval_failed") {
      return fail("DATABASE_UNAVAILABLE", "The knowledge base is temporarily unavailable.", true);
    }
    return ok({
      status: res.status, confidenceScore: res.confidenceScore, evidenceVerified: res.evidenceVerified,
      requiresEscalation: res.requiresEscalation, escalationReason: res.escalationReason, appliedFilters: res.appliedFilters, usage: res.usage,
      sources: res.sources.map((s) => ({ chunkId: s.chunkId, document: s.document, heading: s.heading, content: s.content, similarity: s.similarity, specificity: s.specificity })),
    });
  }
}
