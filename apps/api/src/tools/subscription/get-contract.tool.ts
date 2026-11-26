import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { ContractsService } from "../../contracts/contracts.service.js";
import { ToolError } from "../errors/tool-error.js";
import { AuthorizationService } from "../middleware/authorization.service.js";
import type { ToolDefinition, ToolExecutionContext } from "../registry/tool-definition.interface.js";
import { ok } from "../types/tool-result.js";

const input = z.object({ customerId: z.string().optional() });
type Input = z.infer<typeof input>;

@Injectable()
export class GetContractTool implements ToolDefinition<Input> {
  readonly name = "get_contract";
  readonly description = "Get the verified customer's contract type, status, dates and auto-renew setting.";
  readonly inputSchema = input;
  readonly type = "read" as const;
  readonly requiresIdentity = true;
  readonly timeoutMs = 5_000;
  readonly maxRetries = 2;

  constructor(
    @Inject(ContractsService) private readonly contracts: ContractsService,
    @Inject(AuthorizationService) private readonly auth: AuthorizationService,
  ) {}

  async execute(i: Input, ctx: ToolExecutionContext) {
    this.auth.assertSameCustomer(ctx, i.customerId);
    const c = await this.contracts.getForCustomer(ctx.customerId!);
    if (!c) throw new ToolError("CUSTOMER_NOT_FOUND", "No contract is on file for this customer.");
    return ok({ customerId: ctx.customerId!, contract: { id: c.id, type: c.type, status: c.status, startDate: c.startDate, endDate: c.endDate, autoRenew: c.autoRenew } });
  }
}
