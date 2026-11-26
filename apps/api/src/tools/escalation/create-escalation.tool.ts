import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { ESCALATION_CATEGORIES, ESCALATION_PRIORITIES, ESCALATION_REASONS, EscalationsService } from "../../escalations/escalations.service.js";
import type { ToolDefinition, ToolExecutionContext } from "../registry/tool-definition.interface.js";
import { ok } from "../types/tool-result.js";

const input = z.object({
  reason: z.enum(ESCALATION_REASONS),
  category: z.enum(ESCALATION_CATEGORIES),
  priority: z.enum(ESCALATION_PRIORITIES).optional(),
  summary: z.string().trim().min(1).max(1000),
  inquiry: z.string().trim().max(2000).optional(),
  policyReferences: z.array(z.object({ document: z.string().max(200), heading: z.string().max(200) })).max(10).optional(),
});
type Input = z.infer<typeof input>;

@Injectable()
export class CreateEscalationTool implements ToolDefinition<Input> {
  readonly name = "create_escalation_ticket";
  readonly description =
    "Create a persistent human-support ticket when the request cannot be resolved automatically (approval needed, no supporting policy, low confidence, repeated failures). Works for unverified customers too.";
  readonly inputSchema = input;
  readonly type = "write" as const;
  readonly requiresIdentity = false;
  readonly timeoutMs = 10_000;
  readonly maxRetries = 2;

  constructor(@Inject(EscalationsService) private readonly escalations: EscalationsService) {}

  async execute(i: Input, ctx: ToolExecutionContext) {
    const t = await this.escalations.create(ctx, i);
    return ok({ ticketId: t.ticketId, customerId: t.customerId, category: t.category, priority: t.priority, reason: t.reason, summary: t.summary, status: t.status, replayed: t.replayed });
  }
}
