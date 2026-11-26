import { CONFIRMATION_REQUIRED } from "../policies/tool-selection-policy.js";
import { hashArguments } from "../memory/pending-actions.service.js";
import type { AgentStateType, AgentStateUpdate, BusinessAction, RetrievedDoc } from "../state/agent-state.js";
import { emit, loadTrusted, toolMessage, type AgentDeps } from "./node-deps.js";
import { runTool } from "./tool-runner.js";

interface SearchData {
  status: string;
  confidenceScore: number;
  requiresEscalation: boolean;
  usage?: { embeddingTokens: number };
  sources: Array<{ chunkId: string; document: string; heading: string; content: string; similarity: number }>;
}

/**
 * Executes the pending tool call through the Phase 3 executor, which re-validates the session, authorization and
 * business rules on every call. Sensitive tools run only with a confirmed, unexpired, argument-matching pending
 * action, and use that action's id as the idempotency key (one confirmation can produce at most one refund).
 */
export const createExecuteToolNode = (d: AgentDeps) => async (state: AgentStateType): Promise<AgentStateUpdate> => {
  const call = state.pendingToolCall;
  if (!call) return {};
  const cleared: AgentStateUpdate = { pendingToolCall: null, pendingConfirmation: null, confirmedActionId: null };

  let idempotencyKey: string | undefined;
  if (CONFIRMATION_REQUIRED.has(call.name)) {
    const p = state.pendingConfirmation;
    const action = p && state.confirmedActionId === p.actionId ? await d.pending.get(p.actionId) : null;
    // Defense in depth: even if the graph were mis-routed, a sensitive tool cannot run without a valid confirmation.
    if (!action || action.status !== "confirmed" || action.argumentsHash !== hashArguments(call.name, call.arguments) || action.expiresAt.getTime() < Date.now()) {
      emit(d, state, "guardrail.failed", { guardrail: "business_validation", reason: `${call.name} attempted without a valid customer confirmation`, action: "block" });
      return { ...cleared, lastToolOutcome: { tool: call.name, success: false, errorCode: "CONFIRMATION_REQUIRED", blocked: true },
        messages: [toolMessage(call.id, { success: false, error: { code: "CONFIRMATION_REQUIRED", message: "The customer has not confirmed this action." } })] };
    }
    idempotencyKey = action.id;
  }

  const { result, record } = await runTool(d, state, { name: call.name, input: call.arguments, toolCallId: call.id, idempotencyKey });
  const update: AgentStateUpdate = {
    ...cleared,
    toolCallCount: state.toolCallCount + 1,
    toolResults: [record],
    lastToolOutcome: { tool: call.name, success: result.success, errorCode: result.error?.code, retryable: result.error?.retryable },
    messages: [toolMessage(call.id, result.success ? { success: true, data: result.data } : { success: false, error: result.error })],
  };

  if (idempotencyKey) await d.pending.transition(idempotencyKey, "confirmed", result.success ? "executed" : "failed");
  if (!result.success) return update;

  // ---- successful results update the agent's view of the world ---------------------------------------------------
  const data = result.data as Record<string, unknown>;
  const actions: BusinessAction[] = [];
  let epochBump = false;
  switch (call.name) {
    case "verify_identity": {
      epochBump = true;
      const session = await d.sessions.get(state.sessionId);
      const verified = Boolean(session?.identityVerified && session.customerId);
      if (verified) d.vault.clearSession(state.sessionId, state.runId);
      update.identityVerified = verified;
      update.customerId = verified ? session!.customerId : null;
      update.trusted = verified && session!.customerId ? await loadTrusted(d, session!.customerId) : null;
      break;
    }
    case "issue_refund": {
      epochBump = true;
      actions.push({ type: "refund", ref: String(data.refundId), detail: `refund ${data.refundId} of $${Number(data.amountCents) / 100} for ${data.paymentId}` });
      break;
    }
    case "update_account": {
      epochBump = true;
      if (data.changed) actions.push({ type: "account_update", ref: String(data.field), detail: `${data.field} updated` });
      break;
    }
    case "create_escalation_ticket": {
      epochBump = true;
      actions.push({ type: "escalation", ref: String(data.ticketId), detail: `ticket ${data.ticketId} created` });
      update.escalationTicketId = String(data.ticketId);
      break;
    }
    case "search_knowledge_base": {
      const s = data as unknown as SearchData;
      const docs: RetrievedDoc[] = s.sources.map((x) => ({ id: x.chunkId, document: x.document, heading: x.heading, content: x.content, similarity: x.similarity }));
      update.retrievedDocuments = docs;
      update.retrievalScores = docs.map((x) => x.similarity);
      update.retrievalInsufficient = s.requiresEscalation || docs.length === 0;
      update.evidenceVerified = !update.retrievalInsufficient;
      update.usage = { ...state.usage, embeddingTokens: state.usage.embeddingTokens + (s.usage?.embeddingTokens ?? 0) };
      emit(d, state, "retrieval.completed", { query: String((call.arguments as { query?: unknown }).query ?? ""), status: s.status, confidenceScore: s.confidenceScore, sources: docs.map((x) => ({ document: x.document, heading: x.heading, similarity: x.similarity })) });
      await d.trace.recordRetrieval({ runId: state.runId, sessionId: state.sessionId, toolCallId: call.id, query: String((call.arguments as { query?: unknown }).query ?? ""), verified: update.evidenceVerified, sources: docs });
      break;
    }
  }
  if (actions.length) update.completedActions = actions;
  if (epochBump) update.stateEpoch = state.stateEpoch + 1;
  return update;
};
