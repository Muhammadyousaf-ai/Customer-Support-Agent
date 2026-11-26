import type { AgentRunMetrics, AgentRunStatus } from "@support-ai/contracts";
import { BackendMessages } from "../prompts/response.prompt.js";
import type { AgentStateType, AgentStateUpdate } from "../state/agent-state.js";
import { costOf } from "./decision.node.js";
import { emit, type AgentDeps } from "./node-deps.js";

const CHUNK = 40;

export function metricsOf(d: AgentDeps, s: AgentStateType, startedAtMs = s.startedAtMs): AgentRunMetrics {
  return {
    toolCalls: s.toolCallCount, iterations: s.iterationCount, llmCalls: s.usage.llmCalls, durationMs: Math.max(0, Date.now() - startedAtMs),
    inputTokens: s.usage.inputTokens, outputTokens: s.usage.outputTokens, estimatedCostUsd: Number(costOf(d, s.usage).toFixed(6)),
  };
}

/**
 * Completes the turn: persists the assistant message and run record, records usage, and emits the closing events.
 * The answer is released here, after verification, in chunks. (Model tokens are not streamed straight to the
 * customer because a policy answer must be verified before anything is shown.)
 */
export const createFinalizeNode = (d: AgentDeps) => async (state: AgentStateType): Promise<AgentStateUpdate> => {
  const cancelled = state.halt === "cancelled";
  const status: AgentRunStatus = cancelled ? "cancelled" : (state.status === "running" || state.status === "executing_tool" ? "failed" : state.status);
  const response = cancelled ? BackendMessages.cancelled(state.completedActions) : state.finalResponse ?? BackendMessages.escalationFailed();
  const errorCode = status === "failed" || cancelled ? (state.errorCode ?? (cancelled ? "CANCELLED" : "UNKNOWN")) : null;

  const { message } = await d.memory.append({ sessionId: state.sessionId, role: "assistant", content: response, mode: state.mode, runId: state.runId });

  const metrics = metricsOf(d, state);
  await d.trace.saveUsage(state.runId, d.llm.model, metrics, state.usage.llmLatencyMs, state.usage.embeddingTokens);
  const sources = state.citedSourceIds.flatMap((id) => state.retrievedDocuments.filter((x) => x.id === id).map((x) => ({ document: x.document, heading: x.heading })));
  await d.runs.finish(state.runId, { status, response, errorCode, metrics, sources, escalationTicketId: state.escalationTicketId });

  if (!cancelled && status !== "failed") for (let i = 0; i < response.length; i += CHUNK) emit(d, state, "response.delta", { text: response.slice(i, i + CHUNK) });
  emit(d, state, "response.completed", { text: response, messageId: message.id });
  emit(d, state, "usage.updated", { inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens, llmCalls: metrics.llmCalls, estimatedCostUsd: metrics.estimatedCostUsd });
  if (cancelled) emit(d, state, "run.cancelled", { reconciledActions: state.completedActions.map((a) => a.detail) });
  else if (status === "failed") emit(d, state, "run.failed", { errorCode: errorCode ?? "UNKNOWN", message: response });
  else emit(d, state, "run.completed", { status, durationMs: metrics.durationMs });

  // Best effort, off the critical path of the answer: fold old messages into the summary.
  void d.summarizer.maybeSummarize(state.sessionId);
  return { finalResponse: response, status };
};
