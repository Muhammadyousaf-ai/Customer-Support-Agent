export const TOOL_NAMES = [
  "verify_identity",
  "get_subscription",
  "get_contract",
  "get_payment_history",
  "search_knowledge_base",
  "check_refund_eligibility",
  "issue_refund",
  "update_account",
  "create_escalation_ticket",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOL_ERROR_CODES = [
  "IDENTITY_REQUIRED",
  "VERIFICATION_FAILED",
  "CUSTOMER_NOT_FOUND",
  "INVALID_ARGUMENTS",
  "ACCESS_DENIED",
  "POLICY_NOT_FOUND",
  "REFUND_NOT_ELIGIBLE",
  "MANUAL_APPROVAL_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "TOOL_NOT_FOUND",
  "SESSION_INVALID",
  "TOOL_TIMEOUT",
  "DATABASE_UNAVAILABLE",
  "SIMULATED_FAILURE",
  "INTERNAL_ERROR",
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolErrorInfo {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  /** Safe, structured context (e.g. refund reason code). Never contains secrets. */
  details?: Record<string, unknown>;
}

export interface ToolResult<T> {
  success: boolean;
  data?: T;
  error?: ToolErrorInfo;
  metadata: {
    executionId: string;
    durationMs: number;
    executedAt: string;
    attempts: number;
  };
}

export interface ToolEventData {
  tool: string;
  toolCallId: string;
  executionId: string;
  status?: "success" | "failed";
  durationMs?: number;
  attempt?: number;
  errorCode?: ToolErrorCode;
  /** Safe, whitelisted fields of a completed write action (refund, ticket, account update) for UI cards. */
  result?: Record<string, string | number | boolean | null>;
}
