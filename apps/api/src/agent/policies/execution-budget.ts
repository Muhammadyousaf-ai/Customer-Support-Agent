import type { AgentConfig } from "../config/agent.config.js";
import type { AgentStateType, HaltReason } from "../state/agent-state.js";

export interface RunFlags {
  cancelled: boolean;
  deadlineExceeded: boolean;
}

/**
 * Returns why the run must stop, or null. Checked before every model call and tool call, so no loop can run
 * forever: iterations, tool calls and wall-clock time are all bounded.
 */
export function haltReason(state: AgentStateType, cfg: AgentConfig, flags: RunFlags, now = Date.now()): HaltReason | null {
  if (flags.cancelled) return "cancelled";
  if (flags.deadlineExceeded || (state.startedAtMs > 0 && now - state.startedAtMs > cfg.deadlineMs)) return "deadline";
  if (state.iterationCount >= cfg.maxIterations) return "iterations";
  if (state.toolCallCount >= cfg.maxToolCalls) return "tool_budget";
  return null;
}
