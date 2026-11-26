import type { ToolErrorCode, ToolErrorInfo } from "@support-ai/contracts";

/** Expected, structured failure. Thrown inside tools/services, converted to a ToolResult by the executor. */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const RETRYABLE_PG_CODES = new Set(["57P01", "57P02", "57P03", "53300", "40001", "40P01", "08000", "08003", "08006"]);
const RETRYABLE_NET_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"]);

/** Never leaks internals: unknown errors become a generic INTERNAL_ERROR. */
export function toErrorInfo(err: unknown): ToolErrorInfo {
  if (err instanceof ToolError) {
    return { code: err.code, message: err.message, retryable: err.retryable, ...(err.details ? { details: err.details } : {}) };
  }
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && (RETRYABLE_PG_CODES.has(code) || RETRYABLE_NET_CODES.has(code) || code.startsWith("08"))) {
    return { code: "DATABASE_UNAVAILABLE", message: "The database is temporarily unavailable.", retryable: true };
  }
  return { code: "INTERNAL_ERROR", message: "The tool failed unexpectedly.", retryable: false };
}
