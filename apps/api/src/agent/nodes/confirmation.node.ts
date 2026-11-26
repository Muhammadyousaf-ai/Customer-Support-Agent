import { interrupt } from "@langchain/langgraph";
import { BackendMessages } from "../prompts/response.prompt.js";
import { hashArguments } from "../memory/pending-actions.service.js";
import type { AgentStateType, AgentStateUpdate } from "../state/agent-state.js";
import { emit, toolMessage, type AgentDeps } from "./node-deps.js";

/** What the service passes to `Command({ resume })` when the customer answers. */
export interface ConfirmationResume {
  decision: "confirm" | "decline" | "other" | "cancel";
  /** If the client names an action (explicit resume API), it must be the pending one. */
  actionId?: string;
  /** For "other": the customer's (sanitized) message, handled as a new request. */
  message?: string;
}

/** What the graph publishes when it pauses. */
export interface ConfirmationInterrupt {
  kind: "confirmation";
  actionId: string;
  type: "refund" | "account_update";
  summary: string;
  amountCents?: number;
  currency?: string;
  expiresAt: string;
  display: Record<string, string>;
}

/**
 * Pauses the run until the customer confirms THIS specific action. State is checkpointed in PostgreSQL, so the
 * confirmation can arrive minutes later, after a restart, or through the other interface (chat <-> voice).
 *
 * On resume LangGraph re-runs this node from the top, which is why everything before interrupt() is idempotent.
 * A generic "yes" can only ever confirm the one pending action; it is re-checked here for expiry, ownership,
 * argument integrity and that identity is still verified, before the action is marked confirmed.
 */
export const createConfirmationNode = (d: AgentDeps) => async (state: AgentStateType): Promise<AgentStateUpdate> => {
  const p = state.pendingConfirmation;
  if (!p || !state.customerId) return { pendingToolCall: null, pendingConfirmation: null };

  const { created } = await d.pending.createIfAbsent({ sessionId: state.sessionId, runId: state.runId, customerId: state.customerId, state: p });
  if (created) emit(d, state, "confirmation.required", { actionId: p.actionId, type: p.type, summary: p.summary, amountCents: p.amountCents, currency: p.currency, expiresAt: p.expiresAt, display: p.display });

  const payload: ConfirmationInterrupt = { kind: "confirmation", actionId: p.actionId, type: p.type, summary: p.summary, amountCents: p.amountCents, currency: p.currency, expiresAt: p.expiresAt, display: p.display };
  const reply = interrupt(payload) as ConfirmationResume;

  // ---- resumed ----------------------------------------------------------------------------------------------------
  const resumed = { startedAtMs: Date.now(), status: "running" as const }; // waiting for the customer does not count toward the deadline
  const drop = { pendingToolCall: null, pendingConfirmation: null, confirmedActionId: null };
  const reject = (note: Record<string, unknown>): AgentStateUpdate => ({ ...resumed, ...drop, messages: [toolMessage(p.toolCallId, { success: false, error: note })] });

  if (reply.decision === "cancel") {
    await d.pending.transition(p.actionId, "pending", "superseded");
    return { ...resumed, ...drop, halt: "cancelled", messages: [toolMessage(p.toolCallId, { success: false, error: { code: "CANCELLED", message: "The customer cancelled." } })] };
  }

  const action = await d.pending.get(p.actionId);
  if (!action || action.status !== "pending") {
    return reject({ code: "ACTION_NO_LONGER_PENDING", message: "This confirmation was already handled. Nothing was executed." });
  }
  if (Date.now() > action.expiresAt.getTime()) {
    await d.pending.transition(p.actionId, "pending", "expired");
    return reject({ code: "CONFIRMATION_EXPIRED", message: "The confirmation expired. If the customer still wants this, start again from eligibility checks." });
  }
  if (reply.actionId && reply.actionId !== p.actionId) {
    // A reply that names a different action never authorizes this one.
    return reject({ code: "ACTION_MISMATCH", message: "The reply referred to a different action. Nothing was executed." });
  }

  if (reply.decision === "decline") {
    await d.pending.transition(p.actionId, "pending", "declined");
    emit(d, state, "guardrail.passed", { guardrail: "business_validation", detail: "customer declined; action not executed" });
    return { ...resumed, ...drop, messages: [toolMessage(p.toolCallId, { success: false, error: { code: "CUSTOMER_DECLINED", message: BackendMessages.declined() + " Do not perform the action." } })] };
  }

  if (reply.decision === "other") {
    await d.pending.transition(p.actionId, "pending", "superseded");
    return {
      ...resumed, ...drop,
      messages: [
        toolMessage(p.toolCallId, { success: false, error: { code: "NOT_CONFIRMED", message: "The customer did not confirm; the pending action was cancelled. Their new message follows." } }),
        { role: "user", content: reply.message ?? "" },
      ],
    };
  }

  // ---- decision === "confirm": re-validate everything before releasing the action ----------------------------------
  const session = await d.sessions.get(state.sessionId);
  const stillVerified = Boolean(session?.identityVerified && session.customerId === action.customerId);
  const intact = action.argumentsHash === p.argumentsHash && action.argumentsHash === hashArguments(action.tool, action.arguments);
  if (!stillVerified || !intact) {
    await d.pending.transition(p.actionId, "pending", "declined");
    emit(d, state, "guardrail.failed", { guardrail: "business_validation", reason: !stillVerified ? "identity no longer verified at confirmation" : "pending action was altered", action: "block" });
    return reject({ code: stillVerified ? "ACTION_TAMPERED" : "IDENTITY_REQUIRED", message: "The confirmation could not be honoured. Nothing was executed." });
  }
  if (!(await d.pending.transition(p.actionId, "pending", "confirmed"))) {
    return reject({ code: "ACTION_NO_LONGER_PENDING", message: "This confirmation was already handled. Nothing was executed." });
  }
  // The stored arguments, not anything the model says now, are what will run.
  return { ...resumed, confirmedActionId: p.actionId, pendingToolCall: { id: p.toolCallId, name: action.tool, arguments: action.arguments } };
};
