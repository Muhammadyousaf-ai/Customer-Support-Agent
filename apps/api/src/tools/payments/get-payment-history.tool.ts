import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { PaymentsService } from "../../payments/payments.service.js";
import { AuthorizationService } from "../middleware/authorization.service.js";
import type { ToolDefinition, ToolExecutionContext } from "../registry/tool-definition.interface.js";
import { ok } from "../types/tool-result.js";

const input = z.object({ customerId: z.string().optional(), limit: z.number().int().min(1).max(25).default(10) });
type Input = z.infer<typeof input>;

@Injectable()
export class GetPaymentHistoryTool implements ToolDefinition<Input> {
  readonly name = "get_payment_history";
  readonly description = "List the verified customer's recent payments with amounts (in cents), dates and refunded amounts.";
  readonly inputSchema = input;
  readonly type = "read" as const;
  readonly requiresIdentity = true;
  readonly timeoutMs = 5_000;
  readonly maxRetries = 2;

  constructor(
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(AuthorizationService) private readonly auth: AuthorizationService,
  ) {}

  async execute(i: Input, ctx: ToolExecutionContext) {
    this.auth.assertSameCustomer(ctx, i.customerId);
    const now = Date.now();
    const rows = await this.payments.history(ctx.customerId!, i.limit);
    return ok({
      customerId: ctx.customerId!,
      payments: rows.map((p) => ({
        paymentId: p.id, amountCents: p.amountCents, amount: p.amountCents / 100, currency: p.currency, status: p.status,
        paidAt: p.paidAt.toISOString(), daysSincePayment: Math.max(0, Math.floor((now - p.paidAt.getTime()) / 86_400_000)),
        refundedCents: p.refundedCents, refundableCents: p.status === "succeeded" ? p.amountCents - p.refundedCents : 0,
      })),
    });
  }
}
