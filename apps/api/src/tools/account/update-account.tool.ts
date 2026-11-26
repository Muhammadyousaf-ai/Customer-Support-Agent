import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { CustomersService, UPDATABLE_FIELDS } from "../../customers/customers.service.js";
import type { ToolDefinition, ToolExecutionContext } from "../registry/tool-definition.interface.js";
import { ok } from "../types/tool-result.js";

// `field` is a free string on purpose: restricted fields must reach the service and be refused with
// ACCESS_DENIED / MANUAL_APPROVAL_REQUIRED, not fail as a generic schema error.
const input = z.object({ field: z.string().min(1).max(64), value: z.unknown() });
type Input = z.infer<typeof input>;

@Injectable()
export class UpdateAccountTool implements ToolDefinition<Input> {
  readonly name = "update_account";
  readonly description = `Update one permitted account field for the verified customer. Permitted: ${UPDATABLE_FIELDS.join(", ")}. Subscription tier, balance, password, customer id and permissions can never be changed; billingEmail needs human approval.`;
  readonly inputSchema = input;
  readonly type = "write" as const;
  readonly requiresIdentity = true;
  readonly timeoutMs = 10_000;
  readonly maxRetries = 2;

  constructor(@Inject(CustomersService) private readonly customers: CustomersService) {}

  async execute(i: Input, ctx: ToolExecutionContext) {
    const r = await this.customers.updateField(ctx.sessionId, ctx.customerId!, i.field, i.value);
    return ok({ customerId: ctx.customerId!, ...r });
  }
}
