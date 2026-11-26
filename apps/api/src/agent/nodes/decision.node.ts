import { buildContextBlock } from "../prompts/decision.prompt.js";
import { SYSTEM_PROMPT } from "../prompts/system.prompt.js";
import { LlmError, type LlmMessage, type LlmToolDef } from "../providers/llm-provider.interface.js";
import { haltReason } from "../policies/execution-budget.js";
import type { AgentStateType, AgentStateUpdate, HaltReason, UsageState } from "../state/agent-state.js";
import { controlToolDefs, parseDecision } from "../types/agent-decision.js";
import { emit, llmToolDefs, systemNote, toolMessage, type AgentDeps } from "./node-deps.js";

const MAX_INVALID_DECISIONS = 3;

const addUsage = (u: UsageState, inputTokens: number, outputTokens: number, latencyMs: number): UsageState => ({
  ...u, inputTokens: u.inputTokens + inputTokens, outputTokens: u.outputTokens + outputTokens, llmCalls: u.llmCalls + 1, llmLatencyMs: u.llmLatencyMs + latencyMs,
});

/**
 * The autonomous step. The model sees the conversation, trusted context and every tool schema, and must call
 * exactly one function: a business tool or one of four control functions. Its answer is parsed into a typed
 * AgentDecision; the graph then routes on that decision. Nothing here executes anything.
 */
export const createDecisionNode = (d: AgentDeps) => {
  const tools: LlmToolDef[] = [...llmToolDefs(d.registry), ...controlToolDefs()];

  return async (state: AgentStateType): Promise<AgentStateUpdate> => {
    const flags = d.runRegistry.flags(state.runId);
    if (!flags.cancelled && (await d.runs.isCancelRequested(state.runId))) flags.cancelled = true;
    const halt = haltReason(state, d.cfg, flags);
    if (halt) return { halt, decision: null };

    const system = `${SYSTEM_PROMPT}\n\n${buildContextBlock(state, d.cfg)}`;
    const started = Date.now();
    let res;
    try {
      res = await d.llm.complete({ purpose: "decision", system, messages: state.messages, tools, toolChoice: "required", signal: d.runRegistry.signal(state.runId) });
    } catch (err) {
      const code = err instanceof LlmError ? err.code : "LLM_UNAVAILABLE";
      await d.trace.recordLlmCall({ runId: state.runId, sessionId: state.sessionId, purpose: "decision", model: d.llm.model, latencyMs: Date.now() - started, inputTokens: 0, outputTokens: 0, errorCode: code });
      const reason: HaltReason = flags.cancelled ? "cancelled" : flags.deadlineExceeded ? "deadline" : "llm_failure";
      return { halt: reason, errorCode: code, decision: null };
    }

    const usage = addUsage(state.usage, res.usage.inputTokens, res.usage.outputTokens, res.latencyMs);
    // Cancelled while the model was thinking: do not act on whatever it chose.
    if (d.runRegistry.flags(state.runId).cancelled || (await d.runs.isCancelRequested(state.runId))) return { usage, halt: "cancelled", decision: null };
    const parsed = parseDecision(res);
    const decisionLabel = parsed.ok ? (parsed.decision.type === "tool_call" ? `tool_call:${parsed.decision.toolName}` : parsed.decision.type) : "invalid";
    await d.trace.recordLlmCall({
      runId: state.runId, sessionId: state.sessionId, purpose: "decision", model: res.model, latencyMs: res.latencyMs, inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens, decision: decisionLabel,
      ...(d.cfg.tracePrompts ? { prompt: JSON.stringify({ system, messages: state.messages }) } : {}),
    });

    if (!parsed.ok) {
      // Invalid decision: tell the model what was wrong and let it try again, within a bounded number of attempts.
      const first = res.toolCalls[0];
      const messages: LlmMessage[] = first
        ? [{ role: "assistant", content: "", toolCalls: [first] }, toolMessage(first.id, { error: { code: "INVALID_DECISION", message: parsed.error } })]
        : [systemNote(`Your last reply was unusable: ${parsed.error} Call exactly one function.`)];
      const invalid = state.invalidDecisions + 1;
      return { usage, iterationCount: state.iterationCount + 1, invalidDecisions: invalid, decision: null, messages, ...(invalid >= MAX_INVALID_DECISIONS ? { halt: "invalid_decisions" as const } : {}) };
    }

    const decision = parsed.decision;
    emit(d, state, "decision.completed", { decision: decision.type, ...(decision.type === "tool_call" || decision.type === "confirm_action" ? { toolName: decision.toolName } : {}), iteration: state.iterationCount + 1 });
    emit(d, state, "usage.updated", { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, llmCalls: usage.llmCalls, estimatedCostUsd: costOf(d, usage) });

    // Keep the assistant turn in context. Only the first tool call is kept, so every tool_call has exactly one answer.
    const first = res.toolCalls[0];
    const assistant: LlmMessage = first ? { role: "assistant", content: res.content ?? "", toolCalls: [first] } : { role: "assistant", content: res.content ?? "" };

    const call = decision.type === "tool_call" || decision.type === "confirm_action" ? { id: decision.toolCallId, name: decision.toolName, arguments: decision.arguments } : null;
    return { usage, iterationCount: state.iterationCount + 1, invalidDecisions: 0, decision, pendingToolCall: call, messages: [assistant], clarificationQuestion: null };
  };
};

export const costOf = (d: AgentDeps, u: UsageState) => (u.inputTokens * d.cfg.priceInputPerM + u.outputTokens * d.cfg.priceOutputPerM) / 1_000_000;
