import { Inject, Injectable } from "@nestjs/common";
import { SessionsService } from "../../sessions/sessions.service.js";
import { ToolError } from "../errors/tool-error.js";
import type { ToolCall, ToolContextBuilder, ToolExecutionContext } from "./tool-definition.interface.js";

/** Builds the execution context from the stored session. Nothing in it comes from the LLM or the browser. */
@Injectable()
export class ToolContextService implements ToolContextBuilder {
  constructor(@Inject(SessionsService) private readonly sessions: SessionsService) {}

  async build(call: ToolCall): Promise<ToolExecutionContext> {
    const session = await this.sessions.get(call.sessionId);
    if (!session) throw new ToolError("SESSION_INVALID", "Unknown session.");
    if (session.expiresAt.getTime() <= Date.now()) throw new ToolError("SESSION_INVALID", "The session has expired.");
    if (!(await this.sessions.runBelongsToSession(call.runId, call.sessionId))) throw new ToolError("SESSION_INVALID", "Unknown run for this session.");
    return {
      sessionId: session.id,
      runId: call.runId,
      toolCallId: call.toolCallId,
      customerId: session.identityVerified ? (session.customerId ?? undefined) : undefined,
      identityVerified: session.identityVerified && session.customerId !== null,
    };
  }
}
