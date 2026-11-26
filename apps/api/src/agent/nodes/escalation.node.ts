import { BackendMessages } from "../prompts/response.prompt.js";
import type { AgentStateType, AgentStateUpdate, BusinessAction, ToolRecord } from "../state/agent-state.js";
import { emit, lastUserText, type AgentDeps } from "./node-deps.js";
import { runTool } from "./tool-runner.js";

const CATEGORIES = ["billing", "refund", "account", "technical", "other"] as const;
type TicketReason = "MANUAL_APPROVAL_REQUIRED" | "POLICY_NOT_FOUND" | "LOW_CONFIDENCE" | "IDENTITY_FAILED" | "CUSTOMER_REQUESTED" | "TOOL_FAILURE" | "OTHER";

/** Picks the ticket reason from what actually happened in the run, not from the model's free text alone. */
export function ticketReason(state: AgentStateType, modelReason: string): TicketReason {
  const failed = (code: string) => state.toolResults.some((r) => !r.success && r.errorCode === code);
  if (state.errorCode === "VERIFICATION_FAILED") return "LOW_CONFIDENCE";
  if (failed("MANUAL_APPROVAL_REQUIRED")) return "MANUAL_APPROVAL_REQUIRED";
  if (failed("POLICY_NOT_FOUND") || state.retrievalInsufficient) return "POLICY_NOT_FOUND";
  if (failed("VERIFICATION_FAILED")) return "IDENTITY_FAILED";
  if (/\b(human|person|representative|agent|manager)\b/i.test(modelReason)) return "CUSTOMER_REQUESTED";
  if (state.halt || state.errorCode) return "TOOL_FAILURE";
  return "OTHER";
}

export type TicketOutcome =
  | { ok: true; ticketId: string; priority: string; record: ToolRecord; action: BusinessAction }
  | { ok: false; errorCode: string; record: ToolRecord };

/**
 * Creates the escalation ticket through the Phase 3 tool (persistent, idempotent per run). Never reports success
 * unless the ticket was really stored, so a database outage cannot produce a false "I created a ticket".
 */
export async function createTicket(d: AgentDeps, state: AgentStateType, input: { reason: TicketReason; category: string; summary: string }): Promise<TicketOutcome> {
  const policyReferences = [...new Map(state.retrievedDocuments.map((x) => [`${x.document}#${x.heading}`, { document: x.document, heading: x.heading }])).values()].slice(0, 10);
  const key = `${state.runId}:escalation`;
  const { result, record } = await runTool(d, state, {
    name: "create_escalation_ticket",
    toolCallId: key,
    idempotencyKey: key,
    input: {
      reason: input.reason,
      category: (CATEGORIES as readonly string[]).includes(input.category) ? input.category : "other",
      summary: input.summary.slice(0, 1000) || "Escalated by the support agent.",
      inquiry: lastUserText(state).slice(0, 2000) || undefined,
      ...(policyReferences.length ? { policyReferences } : {}),
    },
  });
  if (!result.success) return { ok: false, errorCode: result.error?.code ?? "TOOL_FAILURE", record };
  const t = result.data as { ticketId: string; priority: string; reason: string };
  emit(d, state, "escalation.created", { ticketId: t.ticketId, reason: t.reason, priority: t.priority });
  return { ok: true, ticketId: t.ticketId, priority: t.priority, record, action: { type: "escalation", ref: t.ticketId, detail: `ticket ${t.ticketId} created` } };
}

/** Handles the model's escalate decision and escalations forced by the guardrails. */
export const createEscalationNode = (d: AgentDeps) => async (state: AgentStateType): Promise<AgentStateUpdate> => {
  const decision = state.decision;
  if (decision?.type !== "escalate") return {};
  const reason = ticketReason(state, decision.reason);
  const out = await createTicket(d, state, { reason, category: decision.category, summary: decision.summary });
  const base: AgentStateUpdate = { toolResults: [out.record], toolCallCount: state.toolCallCount + 1 };
  if (!out.ok) {
    return { ...base, status: "failed", errorCode: out.errorCode, finalResponse: BackendMessages.escalationFailed() };
  }
  return {
    ...base,
    status: "escalated",
    escalationTicketId: out.ticketId,
    completedActions: [out.action],
    finalResponse:
      state.errorCode === "VERIFICATION_FAILED" ? BackendMessages.verificationFailedEscalated(out.ticketId)
      : reason === "CUSTOMER_REQUESTED" ? BackendMessages.customerRequestedHuman(out.ticketId)
      : BackendMessages.escalated(out.ticketId, out.priority),
  };
};
