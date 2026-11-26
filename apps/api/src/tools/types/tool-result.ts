import type { ToolErrorCode, ToolResult } from "@support-ai/contracts";

const placeholder = { executionId: "", durationMs: 0, executedAt: "", attempts: 1 };

/** Tools return these; the executor replaces the placeholder metadata with the real values. */
export const ok = <T>(data: T): ToolResult<T> => ({ success: true, data, metadata: placeholder });
export const fail = <T = never>(
  code: ToolErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
): ToolResult<T> => ({ success: false, error: { code, message, retryable, ...(details ? { details } : {}) }, metadata: placeholder });
