import { Inject, Injectable } from "@nestjs/common";
import { RefundsService } from "../../refunds/refunds.service.js";
import type { ToolDefinition, ToolExecutionContext } from "../registry/tool-definition.interface.js";
import { ok } from "../types/tool-result.js";
import { issueRefundInput, type IssueRefundInput } from "./refund.schema.js";

@Injectable()
export class IssueRefundTool implements ToolDefinition<IssueRefundInput> {
  readonly name = "issue_refund";
  readonly description =
    "Issue a simulated refund for a payment. The backend re-checks eligibility itself and refuses anything check_refund_eligibility would not approve. Safe to retry: the same request never refunds twice.";
  readonly inputSchema = issueRefundInput;
  readonly type = "write" as const;
  readonly requiresIdentity = true;
  readonly timeoutMs = 20_000;
  readonly maxRetries = 2;

  constructor(@Inject(RefundsService) private readonly refunds: RefundsService) {}

  async execute(i: IssueRefundInput, ctx: ToolExecutionContext) {
    const refund = await this.refunds.issue(ctx, i.paymentId, i.amountCents);
    return ok(refund);
  }
}
