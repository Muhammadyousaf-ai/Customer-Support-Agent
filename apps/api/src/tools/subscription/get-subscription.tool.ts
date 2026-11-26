import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { SubscriptionsService } from "../../subscriptions/subscriptions.service.js";
import { ToolError } from "../errors/tool-error.js";
import { AuthorizationService } from "../middleware/authorization.service.js";
import type { ToolDefinition, ToolExecutionContext } from "../registry/tool-definition.interface.js";
import { ok } from "../types/tool-result.js";

const input = z.object({ customerId: z.string().optional() });
type Input = z.infer<typeof input>;

@Injectable()
export class GetSubscriptionTool implements ToolDefinition<Input> {
  readonly name = "get_subscription";
  readonly description = "Get the verified customer's subscription tier, billing period, status and monthly price.";
  readonly inputSchema = input;
  readonly type = "read" as const;
  readonly requiresIdentity = true;
  readonly timeoutMs = 5_000;
  readonly maxRetries = 2;

  constructor(
    @Inject(SubscriptionsService) private readonly subscriptions: SubscriptionsService,
    @Inject(AuthorizationService) private readonly auth: AuthorizationService,
  ) {}

  async execute(i: Input, ctx: ToolExecutionContext) {
    this.auth.assertSameCustomer(ctx, i.customerId);
    const s = await this.subscriptions.getForCustomer(ctx.customerId!);
    if (!s) throw new ToolError("CUSTOMER_NOT_FOUND", "No subscription is on file for this customer.");
    return ok({
      customerId: ctx.customerId!,
      subscription: { tier: s.tier, status: s.status, billingPeriod: s.billingPeriod, monthlyPrice: s.monthlyPriceCents / 100, monthlyPriceCents: s.monthlyPriceCents, currency: s.currency },
    });
  }
}
