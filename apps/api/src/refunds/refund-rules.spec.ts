import { describe, expect, it } from "vitest";
import { evaluateRefund, REFUND_WINDOW_MS, type RefundFacts } from "./refund-rules.js";

const NOW = new Date("2026-11-24T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

/** A Pro, monthly, active customer with a $49 payment from 2 days ago: eligible unless a test changes something. */
const facts = (over: Partial<RefundFacts> = {}): RefundFacts => ({
  identityVerified: true,
  sessionCustomerId: "CUST-002",
  payment: { customerId: "CUST-002", amountCents: 4900, status: "succeeded", paidAt: daysAgo(2), refundedCents: 0 },
  customerStatus: "active",
  subscription: { tier: "pro", billingPeriod: "monthly", status: "active" },
  contract: { type: "monthly", status: "active" },
  now: NOW,
  policyAvailable: true,
  maxAutoRefundCents: 10_000,
  ...over,
});

describe("evaluateRefund", () => {
  it("approves a monthly payment within seven days", () => {
    const r = evaluateRefund(facts());
    expect(r).toMatchObject({ decision: "eligible", eligible: true, reasonCode: "ELIGIBLE", refundableCents: 4900, daysSincePayment: 2 });
    expect(r.checks.every((c) => c.passed)).toBe(true);
  });

  it("is deterministic: same facts, same answer", () => {
    expect(evaluateRefund(facts())).toEqual(evaluateRefund(facts()));
  });

  describe("window boundary", () => {
    it("allows a payment exactly at the seven day limit", () => {
      const paidAt = new Date(NOW.getTime() - REFUND_WINDOW_MS);
      expect(evaluateRefund(facts({ payment: { ...facts().payment, paidAt } })).decision).toBe("eligible");
    });
    it("rejects one millisecond past it", () => {
      const paidAt = new Date(NOW.getTime() - REFUND_WINDOW_MS - 1);
      expect(evaluateRefund(facts({ payment: { ...facts().payment, paidAt } }))).toMatchObject({ decision: "rejected", reasonCode: "REFUND_WINDOW_EXPIRED" });
    });
    it("rejects an old payment", () => {
      expect(evaluateRefund(facts({ payment: { ...facts().payment, paidAt: daysAgo(35) } }))).toMatchObject({ decision: "rejected", reasonCode: "REFUND_WINDOW_EXPIRED", daysSincePayment: 35 });
    });
  });

  it("requires human approval for annual contracts, even when recent and small", () => {
    expect(evaluateRefund(facts({ subscription: { tier: "pro", billingPeriod: "annual", status: "active" }, contract: { type: "annual", status: "active" } })))
      .toMatchObject({ decision: "manual_approval_required", reasonCode: "ANNUAL_CONTRACT" });
  });

  it("requires human approval for Enterprise, even on a monthly contract inside the window", () => {
    expect(evaluateRefund(facts({ subscription: { tier: "enterprise", billingPeriod: "monthly", status: "active" } })))
      .toMatchObject({ decision: "manual_approval_required", reasonCode: "ENTERPRISE_TIER" });
  });

  it("requires human approval above the automated limit", () => {
    const r = evaluateRefund(facts({ payment: { ...facts().payment, amountCents: 15_000 } }));
    expect(r).toMatchObject({ decision: "manual_approval_required", reasonCode: "EXCEEDS_AUTOMATED_LIMIT" });
  });

  it("allows exactly the automated limit", () => {
    expect(evaluateRefund(facts({ payment: { ...facts().payment, amountCents: 10_000 } })).decision).toBe("eligible");
  });

  it("sends suspended accounts to a human", () => {
    for (const over of [{ customerStatus: "suspended" as const }, { subscription: { tier: "pro" as const, billingPeriod: "monthly" as const, status: "suspended" as const } }]) {
      expect(evaluateRefund(facts(over))).toMatchObject({ decision: "manual_approval_required", reasonCode: "ACCOUNT_SUSPENDED" });
    }
  });

  it("still allows an expired subscription to refund a payment inside the window", () => {
    expect(evaluateRefund(facts({ customerStatus: "expired", subscription: { tier: "pro", billingPeriod: "monthly", status: "expired" }, contract: { type: "monthly", status: "expired" } })).decision).toBe("eligible");
  });

  it("escalates when no policy is available or the account has no subscription", () => {
    expect(evaluateRefund(facts({ policyAvailable: false }))).toMatchObject({ decision: "escalate", reasonCode: "POLICY_NOT_FOUND" });
    expect(evaluateRefund(facts({ subscription: null }))).toMatchObject({ decision: "manual_approval_required", reasonCode: "SUBSCRIPTION_NOT_FOUND" });
  });

  describe("hard rejections", () => {
    it("identity not verified", () => {
      expect(evaluateRefund(facts({ identityVerified: false }))).toMatchObject({ decision: "rejected", reasonCode: "IDENTITY_REQUIRED" });
      expect(evaluateRefund(facts({ sessionCustomerId: undefined }))).toMatchObject({ reasonCode: "IDENTITY_REQUIRED" });
    });
    it("payment belongs to someone else", () => {
      expect(evaluateRefund(facts({ sessionCustomerId: "CUST-001" }))).toMatchObject({ decision: "rejected", reasonCode: "PAYMENT_NOT_OWNED" });
    });
    it("payment did not succeed", () => {
      expect(evaluateRefund(facts({ payment: { ...facts().payment, status: "failed" } }))).toMatchObject({ reasonCode: "PAYMENT_NOT_SUCCESSFUL" });
    });
    it("already fully refunded", () => {
      expect(evaluateRefund(facts({ payment: { ...facts().payment, refundedCents: 4900 } }))).toMatchObject({ decision: "rejected", reasonCode: "ALREADY_REFUNDED", refundableCents: 0 });
    });
    it("amount exceeds the refundable balance", () => {
      expect(evaluateRefund(facts({ requestedAmountCents: 5000 }))).toMatchObject({ decision: "rejected", reasonCode: "AMOUNT_EXCEEDS_BALANCE" });
    });
    it("partial refunds are not supported (matches the refund policy)", () => {
      expect(evaluateRefund(facts({ requestedAmountCents: 1000 }))).toMatchObject({ decision: "rejected", reasonCode: "PARTIAL_REFUND_NOT_SUPPORTED" });
    });
    it("hard rejections take priority over approval rules", () => {
      expect(evaluateRefund(facts({ subscription: { tier: "enterprise", billingPeriod: "annual", status: "active" }, payment: { ...facts().payment, refundedCents: 4900 } })).reasonCode).toBe("ALREADY_REFUNDED");
    });
  });
});
