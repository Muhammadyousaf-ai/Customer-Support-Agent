import type { AgentStateType } from "../state/agent-state.js";

export type NodeName =
  | "initialize" | "build_context" | "llm_decision" | "validate_tool" | "execute_tool" | "evaluate_result"
  | "request_clarification" | "request_confirmation" | "verify_response" | "escalate" | "finalize" | "recover";

/** A halting condition always wins: cancellation finalizes, everything else goes through recovery. */
const halted = (s: AgentStateType): NodeName | null => (s.halt ? (s.halt === "cancelled" ? "finalize" : "recover") : null);

export function afterDecision(s: AgentStateType): NodeName {
  const h = halted(s);
  if (h) return h;
  switch (s.decision?.type) {
    case "tool_call":
    case "confirm_action":
      return "validate_tool";
    case "respond":
      return "verify_response";
    case "clarify":
      return "request_clarification";
    case "escalate":
      return "escalate";
    default:
      return "llm_decision"; // invalid decision: try again (bounded by invalidDecisions)
  }
}

export function afterValidate(s: AgentStateType): NodeName {
  const h = halted(s);
  if (h) return h;
  const p = s.pendingConfirmation;
  if (p && s.confirmedActionId !== p.actionId) return "request_confirmation";
  return s.pendingToolCall ? "execute_tool" : "evaluate_result";
}

export function afterConfirmation(s: AgentStateType): NodeName {
  const h = halted(s);
  if (h) return h;
  const p = s.pendingConfirmation;
  return p && s.confirmedActionId === p.actionId && s.pendingToolCall ? "execute_tool" : "llm_decision";
}

export function afterEvaluate(s: AgentStateType): NodeName {
  return halted(s) ?? "llm_decision";
}

export function afterVerify(s: AgentStateType): NodeName {
  if (s.decision?.type === "escalate") return "escalate";
  return s.finalResponse ? "finalize" : "llm_decision";
}
