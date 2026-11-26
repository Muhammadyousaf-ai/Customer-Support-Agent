/** Application-level lifecycle events. Frontends depend on these, never on LangGraph's internal state. */
export const AGENT_EVENT_TYPES = [
  "run.started",
  "context.loaded",
  "decision.completed",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "retrieval.completed",
  "guardrail.passed",
  "guardrail.failed",
  "confirmation.required",
  "clarification.required",
  "response.delta",
  "response.completed",
  "escalation.created",
  "usage.updated",
  "run.paused",
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export interface AgentEvent<T = unknown> {
  type: AgentEventType;
  sessionId: string;
  runId: string;
  /** Strictly increasing per run. */
  seq: number;
  /** Strictly increasing per session (across runs); what SSE clients resume from. */
  sessionSeq?: number;
  ts: string;
  data: T;
}

/** Typed payloads per event (all sanitized: no verification codes, no raw prompts). */
export interface AgentEventPayloads {
  "run.started": { mode: "chat" | "voice"; resumed: boolean };
  "context.loaded": { historyMessages: number; identityVerified: boolean; summarized: boolean };
  "decision.completed": { decision: "tool_call" | "respond" | "clarify" | "confirm_action" | "escalate"; toolName?: string; iteration: number };
  "tool.started": import("./tools.js").ToolEventData;
  "tool.completed": import("./tools.js").ToolEventData;
  "tool.failed": import("./tools.js").ToolEventData;
  "retrieval.completed": { query: string; status: string; confidenceScore: number; sources: Array<{ document: string; heading: string; similarity: number }> };
  "guardrail.passed": { guardrail: GuardrailName; detail?: string };
  "guardrail.failed": { guardrail: GuardrailName; reason: string; action: "retry" | "escalate" | "block" };
  "confirmation.required": { actionId: string; type: "refund" | "account_update"; summary: string; amountCents?: number; currency?: string; expiresAt: string; display: Record<string, string> };
  "clarification.required": { question: string; requiredFields: string[] };
  "response.delta": { text: string };
  "response.completed": { text: string; messageId?: number };
  "escalation.created": { ticketId: string; reason: string; priority: string };
  "usage.updated": { inputTokens: number; outputTokens: number; llmCalls: number; estimatedCostUsd: number };
  "run.paused": { reason: "awaiting_input" | "awaiting_confirmation" };
  "run.completed": { status: string; durationMs: number };
  "run.failed": { errorCode: string; message: string };
  "run.cancelled": { reconciledActions: string[] };
}

export const GUARDRAIL_NAMES = ["scope", "retrieval_confidence", "evidence_verification", "business_validation", "result_verification"] as const;
export type GuardrailName = (typeof GUARDRAIL_NAMES)[number];
