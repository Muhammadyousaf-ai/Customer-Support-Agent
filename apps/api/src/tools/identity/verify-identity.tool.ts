import { Inject, Injectable } from "@nestjs/common";
import { CustomersService } from "../../customers/customers.service.js";
import { ToolError } from "../errors/tool-error.js";
import type { ToolDefinition } from "../registry/tool-definition.interface.js";
import { ok } from "../types/tool-result.js";
import { verifyIdentityInput, type VerifyIdentityInput } from "./identity.schema.js";

@Injectable()
export class VerifyIdentityTool implements ToolDefinition<VerifyIdentityInput, { customerId: string; verified: true; name: string }> {
  readonly name = "verify_identity";
  readonly description =
    "Verify the customer with the email on their account and the 6 digit verification code they were sent. Must succeed before any account-specific tool can be used.";
  readonly inputSchema = verifyIdentityInput;
  readonly type = "read" as const;
  readonly requiresIdentity = false;
  readonly timeoutMs = 5_000;
  readonly maxRetries = 1;

  constructor(@Inject(CustomersService) private readonly customers: CustomersService) {}

  async execute(input: VerifyIdentityInput, ctx: Parameters<ToolDefinition["execute"]>[1]) {
    if (!ctx.sessionId) throw new ToolError("SESSION_INVALID", "No session.");
    const { customerId, name } = await this.customers.verifyIdentity(ctx.sessionId, input.email, input.verificationCode);
    return ok({ customerId, verified: true as const, name });
  }
}
