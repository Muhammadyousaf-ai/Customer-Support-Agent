/**
 * Deterministic refund eligibility. The LLM never decides this: the same facts always give the same answer.
 * Rules mirror knowledge-base/refund-policy.md and account-policy.md; change them together.
 */
export const REFUND_WINDOW_DAYS = 7;
export const REFUND_WINDOW_MS = REFUND_WINDOW_DAYS * 86_400_000;

export type RefundDecision = "eligible" | "rejected" | "manual_approval_required" | "escalate";

export type RefundReasonCode =
  | "ELIGIBLE"
  | "IDENTITY_REQUIRED"
  | "PAYMENT_NOT_OWNED"
  | "PAYMENT_NOT_SUCCESSFUL"
  | "ALREADY_REFUNDED"
  | "AMOUNT_EXCEEDS_BALANCE"
  | "PARTIAL_REFUND_NOT_SUPPORTED"
  | "POLICY_NOT_FOUND"
  | "ACCOUNT_SUSPENDED"
  | "SUBSCRIPTION_NOT_FOUND"
  | "ANNUAL_CONTRACT"
  | "ENTERPRISE_TIER"
  | "REFUND_WINDOW_EXPIRED"
  | "EXCEEDS_AUTOMATED_LIMIT";

export interface RefundFacts {
  identityVerified: boolean;
  /** Customer id from the verified session. */
  sessionCustomerId?: string;
  payment: { customerId: string; amountCents: number; status: "succeeded" | "failed" | "pending"; paidAt: Date; refundedCents: number };
  customerStatus: "active" | "expired" | "suspended";
  subscription: { tier: "free" | "basic" | "pro" | "enterprise"; billingPeriod: "monthly" | "annual"; status: "active" | "expired" | "suspended" | "cancelled" } | null;
  contract: { type: "monthly" | "annual" | "custom"; status: "active" | "expired" | "suspended" } | null;
  /** Omit to request the full refundable balance. */
  requestedAmountCents?: number;
  now: Date;
  /** A grounded refund policy was retrieved for this customer's tier and contract. */
  policyAvailable: boolean;
  maxAutoRefundCents: number;
}

export interface RefundEvaluation {
  decision: RefundDecision;
  eligible: boolean;
  reasonCode: RefundReasonCode;
  explanation: string;
  refundableCents: number;
  daysSincePayment: number;
  checks: Array<{ rule: string; passed: boolean }>;
}

export function evaluateRefund(f: RefundFacts): RefundEvaluation {
  const refundableCents = Math.max(0, f.payment.amountCents - f.payment.refundedCents);
  const elapsedMs = f.now.getTime() - f.payment.paidAt.getTime();
  const daysSincePayment = Math.max(0, Math.floor(elapsedMs / 86_400_000));
  const checks: RefundEvaluation["checks"] = [];

  const result = (decision: RefundDecision, reasonCode: RefundReasonCode, explanation: string): RefundEvaluation => ({
    decision, eligible: decision === "eligible", reasonCode, explanation, refundableCents, daysSincePayment, checks,
  });
  /** Records the check; returns true when it FAILED so callers can `if (fails(...)) return`. */
  const fails = (rule: string, passed: boolean) => (checks.push({ rule, passed }), !passed);

  if (fails("identity_verified", f.identityVerified && Boolean(f.sessionCustomerId))) {
    return result("rejected", "IDENTITY_REQUIRED", "The customer's identity has not been verified.");
  }
  if (fails("payment_belongs_to_customer", f.payment.customerId === f.sessionCustomerId)) {
    return result("rejected", "PAYMENT_NOT_OWNED", "This payment does not belong to the verified customer.");
  }
  if (fails("payment_successful", f.payment.status === "succeeded")) {
    return result("rejected", "PAYMENT_NOT_SUCCESSFUL", "Only successful payments can be refunded.");
  }
  if (fails("not_already_refunded", refundableCents > 0)) {
    return result("rejected", "ALREADY_REFUNDED", "This payment has already been fully refunded.");
  }
  const requested = f.requestedAmountCents ?? refundableCents;
  if (fails("amount_within_refundable_balance", requested <= refundableCents)) {
    return result("rejected", "AMOUNT_EXCEEDS_BALANCE", "The requested amount exceeds the refundable balance.");
  }
  if (fails("full_refund_only", requested === refundableCents)) {
    return result("rejected", "PARTIAL_REFUND_NOT_SUPPORTED", "Partial refunds are not supported; the full refundable amount must be refunded.");
  }
  if (fails("policy_available", f.policyAvailable)) {
    return result("escalate", "POLICY_NOT_FOUND", "No applicable refund policy could be retrieved, so a human must decide.");
  }
  if (fails("subscription_found", f.subscription !== null)) {
    return result("manual_approval_required", "SUBSCRIPTION_NOT_FOUND", "No subscription is on file for this customer.");
  }
  const suspended = f.customerStatus === "suspended" || f.subscription?.status === "suspended" || f.contract?.status === "suspended";
  if (fails("account_not_suspended", !suspended)) {
    return result("manual_approval_required", "ACCOUNT_SUSPENDED", "Suspended accounts require human approval for refunds.");
  }
  if (fails("not_enterprise", f.subscription?.tier !== "enterprise")) {
    return result("manual_approval_required", "ENTERPRISE_TIER", "Enterprise refunds always require human approval.");
  }
  const annual = f.subscription?.billingPeriod === "annual" || f.contract?.type === "annual";
  if (fails("not_annual_contract", !annual)) {
    return result("manual_approval_required", "ANNUAL_CONTRACT", "Annual subscription refunds always require human approval.");
  }
  if (fails("within_refund_window", elapsedMs <= REFUND_WINDOW_MS)) {
    return result("rejected", "REFUND_WINDOW_EXPIRED", `The payment is ${daysSincePayment} days old; refunds are only available within ${REFUND_WINDOW_DAYS} days.`);
  }
  if (fails("within_automated_limit", requested <= f.maxAutoRefundCents)) {
    return result("manual_approval_required", "EXCEEDS_AUTOMATED_LIMIT", "The amount exceeds the automated refund limit and needs human approval.");
  }
  return result("eligible", "ELIGIBLE", "All refund checks passed.");
}
