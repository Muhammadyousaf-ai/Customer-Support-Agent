import { z } from "zod";

export const AGENT_RUN_STATUSES = [
  "running",
  "awaiting_input",
  "awaiting_confirmation",
  "completed",
  "escalated",
  "cancelled",
  "failed",
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const sendAgentMessageSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  /** Client-generated id; resending the same id returns the original result instead of running twice. */
  clientMessageId: z.string().trim().min(1).max(100),
  mode: z.enum(["chat", "voice"]).default("chat"),
});
export type SendAgentMessageInput = z.input<typeof sendAgentMessageSchema>;

export const resumeRunSchema = z.object({
  actionId: z.string().min(1).max(100),
  decision: z.enum(["confirm", "decline"]),
});
export type ResumeRunInput = z.infer<typeof resumeRunSchema>;

export interface PendingActionView {
  id: string;
  type: "refund" | "account_update";
  summary: string;
  amountCents?: number;
  currency?: string;
  expiresAt: string;
  /** Labelled facts for the confirmation card, taken from backend records (customer, plan, payment). */
  display: Record<string, string>;
}

/** 202 Accepted: the run executes in the background and reports through the event stream. */
export interface AcceptedMessage {
  sessionId: string;
  messageId: number;
  runId: string;
  status: "processing" | AgentRunStatus;
  /** True when this clientMessageId was already accepted and the original run is returned. */
  duplicate?: boolean;
}

export interface SessionView {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  identityVerified: boolean;
  lastMessage: string | null;
  activeRun: { runId: string; status: AgentRunStatus } | null;
  pendingAction: PendingActionView | null;
}

export const renameSessionSchema = z.object({ title: z.string().trim().min(1).max(80) });

/** Free-text search shared by list endpoints (conversations, tickets). Blank means no filter. */
export const searchTextSchema = z.string().trim().max(100).optional();
export const listOwnSessionsQuerySchema = z.object({ q: searchTextSchema });

export interface AgentRunMetrics {
  toolCalls: number;
  iterations: number;
  llmCalls: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface AgentRunResponse {
  sessionId: string;
  runId: string;
  status: AgentRunStatus;
  response: string;
  pendingAction?: PendingActionView;
  sources: Array<{ document: string; heading: string }>;
  escalationTicketId?: string;
  metrics: AgentRunMetrics;
}
