import type { Env } from "../../config/env.js";

export const AGENT_CONFIG = Symbol("AGENT_CONFIG");

/** Execution budgets and limits. Starting values from the Phase 4 spec; every one is configurable via env. */
export interface AgentConfig {
  maxIterations: number;
  maxToolCalls: number;
  maxEvidenceRetries: number;
  maxRetrievalRefinements: number;
  /** Active execution deadline per run segment. Time spent waiting for the customer does not count. */
  deadlineMs: number;
  confirmationTtlMs: number;
  historyWindow: number;
  llmTimeoutMs: number;
  llmMaxRetries: number;
  priceInputPerM: number;
  priceOutputPerM: number;
  tracePrompts: boolean;
  llmEvidenceCheck: boolean;
  model: string;
}

export function resolveAgentConfig(env: Env): AgentConfig {
  return {
    maxIterations: env.AGENT_MAX_ITERATIONS,
    maxToolCalls: env.AGENT_MAX_TOOL_CALLS,
    maxEvidenceRetries: env.AGENT_MAX_EVIDENCE_RETRIES,
    maxRetrievalRefinements: env.AGENT_MAX_RETRIEVAL_REFINEMENTS,
    deadlineMs: env.AGENT_DEADLINE_MS,
    confirmationTtlMs: env.AGENT_CONFIRMATION_TTL_MS,
    historyWindow: env.AGENT_HISTORY_WINDOW,
    llmTimeoutMs: env.LLM_TIMEOUT_MS,
    llmMaxRetries: env.LLM_MAX_RETRIES,
    priceInputPerM: env.LLM_PRICE_INPUT_PER_M,
    priceOutputPerM: env.LLM_PRICE_OUTPUT_PER_M,
    tracePrompts: env.TRACE_PROMPTS === "true",
    llmEvidenceCheck: env.AGENT_LLM_EVIDENCE_CHECK === "true",
    model: env.OPENAI_CHAT_MODEL,
  };
}

export const estimateCostUsd = (c: Pick<AgentConfig, "priceInputPerM" | "priceOutputPerM">, input: number, output: number) =>
  (input * c.priceInputPerM + output * c.priceOutputPerM) / 1_000_000;
