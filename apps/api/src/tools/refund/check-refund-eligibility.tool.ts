import { Inject, Injectable } from "@nestjs/common";
import { RefundsService } from "../../refunds/refunds.service.js";
import type { ToolDefinition, ToolExecutionContext } from "../registry/tool-definition.interface.js";
import { ok } from "../types/tool-result.js";
import { checkRefundInput, type CheckRefundInput } from "./refund.schema.js";

@Injectable()
export class CheckRefundEligibilityTool implements ToolDefinition<CheckRefundInput> {
  readonly name = "check_refund_eligibility";
  readonly description =
    "Deterministically check whether a payment can be refunded. Returns decision: eligible | rejected | manual_approval_required | escalate, with a reason code. The decision is made by backend rules, not by you. Amounts are in cents.";
  readonly inputSchema = checkRefundInput;
  readonly type = "validation" as const;
  readonly requiresIdentity = true;
  readonly timeoutMs = 15_000;
  readonly maxRetries = 2;

  constructor(@Inject(RefundsService) private readonly refunds: RefundsService) {}

  /** A completed evaluation is a successful call even when the answer is "no": the outcome is in `data.decision`. */
  async execute(i: CheckRefundInput, ctx: ToolExecutionContext) {
    const { evaluation, payment, policy, limits } = await this.refunds.check(ctx, i.paymentId, i.amountCents);
    return ok({
      ...evaluation,
      paymentId: payment.id,
      amountCents: payment.amountCents,
      currency: payment.currency,
      limits,
      policySources: policy.sources,
    });
  }
}
