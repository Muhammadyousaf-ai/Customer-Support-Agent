import type { AgentStateType, AgentStateUpdate } from "../state/agent-state.js";
import type { AgentDeps } from "./node-deps.js";

/**
 * Starts a turn: resets every per-turn counter and restores the *authoritative* identity from the backend session.
 * A previously cached "verified" flag is never trusted; the session row is read again each turn.
 */
export const createInitializeNode = (d: AgentDeps) => async (state: AgentStateType): Promise<AgentStateUpdate> => {
  const session = await d.sessions.get(state.sessionId);
  const verified = Boolean(session?.identityVerified && session.customerId);
  return {
    startedAtMs: Date.now(),
    customerId: verified ? session!.customerId : null,
    identityVerified: verified,
    trusted: null,
    iterationCount: 0, toolCallCount: 0, retryCount: 0, verificationAttempts: 0, failureStreak: 0, blockedRepeats: 0, invalidDecisions: 0, stateEpoch: 0,
    halt: null, decision: null, pendingToolCall: null, pendingConfirmation: null, confirmedActionId: null, clarificationQuestion: null, lastToolOutcome: null,
    retrievalRefinements: 0, retrievalInsufficient: false, evidenceVerified: false,
    draftResponse: null, finalResponse: null, citedSourceIds: [], escalationTicketId: null, status: "running", errorCode: null,
    usage: { inputTokens: 0, outputTokens: 0, llmCalls: 0, llmLatencyMs: 0, embeddingTokens: 0 },
    toolResults: { replace: [] }, completedActions: { replace: [] }, retrievedDocuments: { replace: [] }, retrievalScores: { replace: [] },
  };
};
