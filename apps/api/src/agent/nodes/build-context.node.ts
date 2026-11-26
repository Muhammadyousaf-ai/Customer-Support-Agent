import type { LlmMessage } from "../providers/llm-provider.interface.js";
import type { AgentStateType, AgentStateUpdate } from "../state/agent-state.js";
import { emit, loadTrusted, type AgentDeps } from "./node-deps.js";

/**
 * Prepares what the model will see: the recent conversation from PostgreSQL (shared by chat and voice), the optional
 * summary of older turns, and trusted customer context read from the backend.
 */
export const createBuildContextNode = (d: AgentDeps) => async (state: AgentStateType): Promise<AgentStateUpdate> => {
  const [recent, { summary }] = await Promise.all([d.memory.recent(state.sessionId, d.cfg.historyWindow), d.memory.getSummary(state.sessionId)]);
  const history: LlmMessage[] = recent.map((m) => ({ role: m.role, content: m.content }));
  const trusted = state.identityVerified && state.customerId ? await loadTrusted(d, state.customerId) : null;
  emit(d, state, "context.loaded", { historyMessages: history.length, identityVerified: state.identityVerified, summarized: Boolean(summary) });
  return { messages: { replace: history }, conversationSummary: summary, historyCount: history.length, trusted };
};
