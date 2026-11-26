export type ErrorCategory = "provider" | "rate_limit" | "timeout" | "validation" | "authorization" | "retrieval" | "voice" | "guardrail" | "budget" | "business_rule" | "internal";
export type ErrorKind = "infrastructure" | "business_rule" | "guardrail";

/**
 * A correctly rejected unauthorized refund is the system working, not a malfunction. Business-rule and guardrail
 * outcomes are therefore reported separately from infrastructure failures.
 */
const BUSINESS_RULE = new Set(["ACCESS_DENIED", "IDENTITY_REQUIRED", "VERIFICATION_FAILED", "REFUND_NOT_ELIGIBLE", "MANUAL_APPROVAL_REQUIRED", "CUSTOMER_DECLINED", "POLICY_NOT_FOUND", "ALREADY_REFUNDED", "AMOUNT_EXCEEDS_LIMIT", "CONFIRMATION_REQUIRED", "CONFIRMATION_EXPIRED"]);

export function classifyError(code: string | undefined, message = ""): { category: ErrorCategory; kind: ErrorKind } {
  const c = (code ?? "").toUpperCase();
  if (BUSINESS_RULE.has(c)) return { category: c === "ACCESS_DENIED" || c === "IDENTITY_REQUIRED" || c === "VERIFICATION_FAILED" ? "authorization" : "business_rule", kind: "business_rule" };
  if (/GUARDRAIL|EVIDENCE|SCOPE/.test(c)) return { category: "guardrail", kind: "guardrail" };
  if (/RATE_LIMIT|429/.test(c) || /\b429\b|rate.?limit|quota/i.test(message)) return { category: "rate_limit", kind: "infrastructure" };
  if (/TIMEOUT|DEADLINE/.test(c)) return { category: "timeout", kind: "infrastructure" };
  if (/INVALID_ARGUMENTS|VALIDATION|INVALID_DECISION|INVALID_RESPONSE/.test(c)) return { category: "validation", kind: "infrastructure" };
  if (/^LLM_|PROVIDER/.test(c)) return { category: "provider", kind: "infrastructure" };
  if (/RETRIEVAL|RAG/.test(c)) return { category: "retrieval", kind: "infrastructure" };
  if (/BUDGET|MAX_ITERATIONS|MAX_TOOL/.test(c)) return { category: "budget", kind: "infrastructure" };
  if (/VOICE|AUDIO|PROVIDER_/.test(c)) return { category: "voice", kind: "infrastructure" };
  return { category: "internal", kind: "infrastructure" };
}
