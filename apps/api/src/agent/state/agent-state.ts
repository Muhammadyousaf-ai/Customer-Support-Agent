import { Annotation } from "@langchain/langgraph";
import type { AgentRunStatus } from "@support-ai/contracts";
import type { LlmMessage } from "../providers/llm-provider.interface.js";
import type { AgentDecision } from "../types/agent-decision.js";

export interface TrustedContext {
  customerId: string;
  tier?: string;
  billingPeriod?: string;
  monthlyPriceCents?: number;
  subscriptionStatus?: string;
  contractType?: string;
  contractStatus?: string;
}

export interface RetrievedDoc {
  id: string;
  document: string;
  heading: string;
  content: string;
  similarity: number;
}

/** Compact record of one tool execution. `summary` is a size-capped JSON string used for claim verification. */
export interface ToolRecord {
  tool: string;
  success: boolean;
  errorCode?: string;
  retryable?: boolean;
  signature: string;
  epoch: number;
  executionId: string;
  summary: string;
}

export interface BusinessAction {
  type: "refund" | "account_update" | "escalation" | "identity";
  ref: string;
  detail: string;
}

export interface PendingActionState {
  actionId: string;
  type: "refund" | "account_update";
  toolName: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
  argumentsHash: string;
  summary: string;
  amountCents?: number;
  currency?: string;
  expiresAt: string;
  display: Record<string, string>;
}

export interface UsageState {
  inputTokens: number;
  outputTokens: number;
  llmCalls: number;
  llmLatencyMs: number;
  embeddingTokens: number;
}

export type RunStatusInternal = AgentRunStatus | "executing_tool";
export type HaltReason = "cancelled" | "deadline" | "iterations" | "tool_budget" | "llm_failure" | "failure_streak" | "db_unavailable" | "invalid_decisions" | "blocked_repeats";

const last = <T>(init: () => T) => Annotation<T>({ reducer: (_current, update) => update, default: init });
type ListUpdate<T> = T[] | { replace: T[] };
/** A list that nodes append to, or replace wholesale with `{ replace: [...] }` (used to reset per turn). */
const list = <T>() =>
  Annotation<T[], ListUpdate<T>>({
    reducer: (current, update) => (Array.isArray(update) ? [...current, ...update] : update.replace),
    default: () => [],
  });

/** LangGraph state for one agent thread (thread id = session id). Everything here must be JSON-serialisable. */
export const AgentState = Annotation.Root({
  // execution context
  sessionId: last(() => ""),
  runId: last(() => ""),
  turnId: last(() => ""),
  mode: last<"chat" | "voice">(() => "chat"),
  startedAtMs: last(() => 0),

  // conversation (rebuilt from PostgreSQL each turn, plus this turn's tool traffic)
  messages: list<LlmMessage>(),
  conversationSummary: last<string | null>(() => null),
  historyCount: last(() => 0),

  // trusted customer context (always re-read from the backend, never carried over from an earlier turn)
  customerId: last<string | null>(() => null),
  identityVerified: last(() => false),
  trusted: last<TrustedContext | null>(() => null),

  // knowledge grounding
  retrievedDocuments: list<RetrievedDoc>(),
  retrievalScores: list<number>(),
  retrievalRefinements: last(() => 0),
  retrievalInsufficient: last(() => false),
  evidenceVerified: last(() => false),

  // tool orchestration
  decision: last<AgentDecision | null>(() => null),
  pendingToolCall: last<{ id: string; name: string; arguments: Record<string, unknown> } | null>(() => null),
  toolResults: list<ToolRecord>(),
  /** Outcome of the most recent tool step (including blocked/invalid ones); consumed by evaluate_result. */
  lastToolOutcome: last<{ tool: string; success: boolean; errorCode?: string; retryable?: boolean; blocked?: boolean } | null>(() => null),
  completedActions: list<BusinessAction>(),

  // human interaction
  pendingConfirmation: last<PendingActionState | null>(() => null),
  confirmedActionId: last<string | null>(() => null),
  clarificationQuestion: last<string | null>(() => null),

  // execution limits
  iterationCount: last(() => 0),
  toolCallCount: last(() => 0),
  retryCount: last(() => 0),
  verificationAttempts: last(() => 0),
  failureStreak: last(() => 0),
  blockedRepeats: last(() => 0),
  invalidDecisions: last(() => 0),
  /** Bumped whenever the world changes (identity verified, a write succeeded) so a repeat call is legitimate. */
  stateEpoch: last(() => 0),
  halt: last<HaltReason | null>(() => null),

  usage: last<UsageState>(() => ({ inputTokens: 0, outputTokens: 0, llmCalls: 0, llmLatencyMs: 0, embeddingTokens: 0 })),

  // output
  draftResponse: last<string | null>(() => null),
  finalResponse: last<string | null>(() => null),
  citedSourceIds: last<string[]>(() => []),
  escalationTicketId: last<string | null>(() => null),
  status: last<RunStatusInternal>(() => "running"),
  errorCode: last<string | null>(() => null),
});

export type AgentStateType = typeof AgentState.State;
export type AgentStateUpdate = typeof AgentState.Update;
