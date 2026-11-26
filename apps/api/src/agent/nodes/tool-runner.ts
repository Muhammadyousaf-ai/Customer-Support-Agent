import type { ToolResult } from "@support-ai/contracts";
import { signatureOf } from "../policies/tool-selection-policy.js";
import type { AgentStateType, ToolRecord } from "../state/agent-state.js";
import type { AgentDeps } from "./node-deps.js";

const SUMMARY_CAP = 2000;

/** Compact, size-capped JSON of a result. Used to verify the model's claims against what tools really returned. */
export const summarize = (result: ToolResult<unknown>): string => {
  const text = JSON.stringify(result.success ? result.data : result.error);
  return text.length > SUMMARY_CAP ? text.slice(0, SUMMARY_CAP) : text;
};

/**
 * Runs one Phase 3 tool for the agent. Placeholders for secrets are resolved only here, at the last moment, so
 * the real verification code exists only in memory for the duration of the call.
 */
export async function runTool(
  d: AgentDeps,
  state: Pick<AgentStateType, "runId" | "sessionId" | "stateEpoch">,
  call: { name: string; input: unknown; toolCallId: string; idempotencyKey?: string },
): Promise<{ result: ToolResult<unknown>; record: ToolRecord }> {
  const result = await d.tools.execute({
    tool: call.name,
    input: d.vault.resolveArgs(state.runId, call.name, call.input),
    sessionId: state.sessionId,
    runId: state.runId,
    toolCallId: call.toolCallId,
    ...(call.idempotencyKey ? { idempotencyKey: call.idempotencyKey } : {}),
  });
  return {
    result,
    record: {
      tool: call.name,
      success: result.success,
      errorCode: result.error?.code,
      retryable: result.error?.retryable,
      signature: signatureOf(call.name, call.input, state.stateEpoch),
      epoch: state.stateEpoch,
      executionId: result.metadata.executionId,
      summary: summarize(result),
    },
  };
}
