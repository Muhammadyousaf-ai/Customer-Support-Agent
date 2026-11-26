import type { PendingActionView } from "@support-ai/contracts";

/** Spec: the UI's view of a run. Derived purely from backend events. */
export type RunStatus = "idle" | "processing" | "streaming" | "awaiting_input" | "awaiting_confirmation" | "completed" | "failed" | "cancelled";

export type ToolStatus = "running" | "completed" | "failed" | "retrying" | "awaiting_confirmation" | "cancelled";

export interface ToolExecution {
  /** toolCallId, so each distinct call is its own row. The sequence of rows is whatever the agent actually did. */
  id: string;
  tool: string;
  status: ToolStatus;
  attempt: number;
  durationMs?: number;
  errorCode?: string;
  /** For the synthetic "awaiting your confirmation" row. */
  detail?: string;
  startedSequence: number;
}

export interface PolicySource {
  document: string;
  heading: string;
  similarity: number;
}

export interface GuardrailResult {
  guardrail: string;
  passed: boolean;
  detail?: string;
  action?: string;
}

export interface RefundResult {
  refundId: string;
  paymentId: string;
  amountCents: number;
  currency: string;
  simulated: boolean;
}

export interface EscalationTicket {
  ticketId: string;
  reason: string;
  priority: string;
  status: "open";
}

export interface RunView {
  runId: string;
  status: RunStatus;
  tools: ToolExecution[];
  sources: PolicySource[];
  guardrails: GuardrailResult[];
  /** Verified answer text, released in chunks after verification (buffered streaming, not raw model tokens). */
  streamingText: string;
  finalText?: string;
  messageId?: number;
  pendingAction: PendingActionView | null;
  refund?: RefundResult;
  ticket?: EscalationTicket;
  clarification?: { question: string; requiredFields: string[] };
  error?: { code: string; message: string };
  usage?: { inputTokens: number; outputTokens: number; llmCalls: number; estimatedCostUsd: number };
  /** Set when events replayed a run that had already finished before the page loaded. */
  replayed?: boolean;
}

export interface ChatError {
  kind: "network" | "rate_limited" | "conflict" | "unauthorized" | "server" | "unknown";
  message: string;
  retryable: boolean;
}

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "disconnected";
