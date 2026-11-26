import { BackendMessages } from "../prompts/response.prompt.js";
import type { AgentStateType, AgentStateUpdate, HaltReason } from "../state/agent-state.js";
import { createTicket, ticketReason } from "./escalation.node.js";
import type { AgentDeps } from "./node-deps.js";

const ERROR_CODES: Record<HaltReason, string> = {
  cancelled: "CANCELLED",
  deadline: "DEADLINE_EXCEEDED",
  iterations: "MAX_ITERATIONS",
  tool_budget: "MAX_TOOL_CALLS",
  llm_failure: "LLM_FAILURE",
  failure_streak: "TOOL_FAILURES",
  db_unavailable: "DATABASE_UNAVAILABLE",
  invalid_decisions: "INVALID_DECISIONS",
  blocked_repeats: "REPEATED_CALLS",
};

/**
 * Where every failure ends up: budget exhausted, model down, tools failing, database unavailable, runaway loops.
 * The customer always gets an honest message. It tries to escalate once, and only says a ticket exists if the
 * ticket was actually persisted. Sensitive operations are never retried from here.
 */
export const createRecoveryNode = (d: AgentDeps) => async (state: AgentStateType): Promise<AgentStateUpdate> => {
  const halt = state.halt ?? "llm_failure";
  const errorCode = state.errorCode ?? ERROR_CODES[halt];
  const withCode = { ...state, errorCode };
  const out = await createTicket(d, withCode, {
    reason: ticketReason(withCode, halt),
    category: "other",
    summary: `The agent stopped early (${halt.replace(/_/g, " ")}; ${errorCode}). Customer request needs human follow-up.`,
  });
  const base: AgentStateUpdate = { errorCode, toolResults: [out.record] };
  if (!out.ok) return { ...base, status: "failed", finalResponse: BackendMessages.escalationFailed() };
  return { ...base, status: "escalated", escalationTicketId: out.ticketId, completedActions: [out.action], finalResponse: BackendMessages.recoveredAndEscalated(out.ticketId) };
};
