import type { ToolResult } from "@support-ai/contracts";
import type { z } from "zod";

export type ToolType = "read" | "retrieval" | "validation" | "write";

/** Built by the trusted backend from the stored session. Never supplied by the LLM or the frontend. */
export interface ToolExecutionContext {
  sessionId: string;
  runId: string;
  toolCallId: string;
  customerId?: string;
  identityVerified: boolean;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  type: ToolType;
  requiresIdentity: boolean;
  timeoutMs: number;
  maxRetries: number;
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolResult<TOutput>>;
}

/** What the orchestrator submits. Everything else is derived server-side. */
export interface ToolCall {
  tool: string;
  input: unknown;
  sessionId: string;
  runId: string;
  toolCallId: string;
  /** Optional caller-chosen key; otherwise derived from session + tool + arguments for write tools. */
  idempotencyKey?: string;
}

export interface ToolContextBuilder {
  build(call: ToolCall): Promise<ToolExecutionContext>;
}

export interface ExecutionLogEntry {
  executionId: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
  tool: string;
  toolType?: ToolType;
  args: unknown;
  result: unknown;
  status: "success" | "failed";
  errorCode?: string;
  attempts: number;
  durationMs: number;
  idempotencyKey?: string;
}
export interface ExecutionLog {
  record(entry: ExecutionLogEntry): Promise<void>;
}

export const TOOLS = Symbol("TOOLS");
export const TOOL_CONTEXT_BUILDER = Symbol("TOOL_CONTEXT_BUILDER");
export const EXECUTION_LOG = Symbol("EXECUTION_LOG");
export const TOOL_RUNTIME_CONFIG = Symbol("TOOL_RUNTIME_CONFIG");

export interface ToolRuntimeConfig {
  retryBaseDelayMs: number;
  /** Test/demo override for every tool's timeout. */
  timeoutOverrideMs?: number;
}
