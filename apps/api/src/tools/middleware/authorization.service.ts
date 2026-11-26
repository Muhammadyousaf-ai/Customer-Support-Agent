import { Injectable } from "@nestjs/common";
import { ToolError } from "../errors/tool-error.js";
import type { ToolDefinition, ToolExecutionContext } from "../registry/tool-definition.interface.js";

@Injectable()
export class AuthorizationService {
  /** Session-based gate. Identity comes from the stored session, never from tool arguments. */
  authorize(tool: ToolDefinition, ctx: ToolExecutionContext): void {
    if (tool.requiresIdentity && (!ctx.identityVerified || !ctx.customerId)) {
      throw new ToolError("IDENTITY_REQUIRED", "The customer must verify their identity before this action.");
    }
  }

  /** A tool may name a customer only if it is the verified one. */
  assertSameCustomer(ctx: ToolExecutionContext, requestedCustomerId: string | undefined): void {
    if (requestedCustomerId !== undefined && requestedCustomerId !== ctx.customerId) {
      throw new ToolError("ACCESS_DENIED", "You can only access your own account.");
    }
  }
}
