import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALEX, EMMA, JAMES, OLIVIA, SARAH, buildHarness, count, dataOf, dbAvailable, errorOf, pool, type Harness } from "./harness.js";

/** Real Postgres + pgvector. Skipped automatically if the database or migrations are unavailable. */
describe.skipIf(!dbAvailable)("business tools (integration)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = buildHarness();
    await h.ingestion.ingestDirectory(); // knowledge base for search_knowledge_base and the refund policy lookup
  });
  beforeEach(async () => {
    await h.reset();
    h.simulator.clear();
  });

  describe("identity verification", () => {
    it("verifies a valid customer and stores it on the backend session", async () => {
      const s = await h.session();
      const r = await s.run("verify_identity", { email: SARAH.email, verificationCode: SARAH.code });
      expect(r.success).toBe(true);
      expect(dataOf(r)).toEqual({ customerId: "CUST-002", verified: true, name: "Sarah Wilson" });
      const { rows } = await pool.query("select customer_id, identity_verified from sessions where id = $1", [s.sessionId]);
      expect(rows[0]).toEqual({ customer_id: "CUST-002", identity_verified: true });
    });

    it("rejects a wrong code and leaves the session unverified", async () => {
      const s = await h.session();
      const r = await s.run("verify_identity", { email: SARAH.email, verificationCode: "000000" });
      expect(errorOf(r)).toMatchObject({ code: "VERIFICATION_FAILED", retryable: false, details: { attemptsRemaining: 4 } });
      const { rows } = await pool.query("select identity_verified from sessions where id = $1", [s.sessionId]);
      expect(rows[0].identity_verified).toBe(false);
    });

    it("gives the same answer for an unknown email as for a wrong code (no account enumeration)", async () => {
      const s = await h.session();
      const unknown = await s.run("verify_identity", { email: "nobody@example.com", verificationCode: "123456" });
      const wrong = await s.run("verify_identity", { email: SARAH.email, verificationCode: "123456" });
      expect(errorOf(unknown)?.code).toBe("VERIFICATION_FAILED");
      expect(errorOf(unknown)?.message).toBe(errorOf(wrong)?.message);
    });

    it("locks the session after five failed attempts, even for the correct code", async () => {
      const s = await h.session();
      for (let i = 0; i < 5; i++) await s.run("verify_identity", { email: SARAH.email, verificationCode: "111111" });
      const r = await s.run("verify_identity", { email: SARAH.email, verificationCode: SARAH.code });
      expect(errorOf(r)?.code).toBe("ACCESS_DENIED");
    });

    it("cannot switch a verified session to a different customer", async () => {
      const s = await h.session(SARAH);
      const r = await s.run("verify_identity", { email: ALEX.email, verificationCode: ALEX.code });
      expect(errorOf(r)?.code).toBe("ACCESS_DENIED");
    });

    it("never stores the verification code in the execution log", async () => {
      const s = await h.session(SARAH);
      const { rows } = await pool.query("select args from tool_executions where run_id = $1 and tool = 'verify_identity'", [s.runId]);
      expect(rows[0].args.verificationCode).toBe("[redacted]");
      expect(JSON.stringify(rows)).not.toContain(SARAH.code);
    });
  });

  describe("authorization", () => {
    it("denies account tools to an unverified session", async () => {
      const s = await h.session();
      for (const [tool, input] of [["get_subscription", {}], ["get_contract", {}], ["get_payment_history", {}], ["check_refund_eligibility", { paymentId: "PAY-002" }],
        ["issue_refund", { paymentId: "PAY-002" }], ["update_account", { field: "displayName", value: "X" }]] as const) {
        expect(errorOf(await s.run(tool, input))?.code, tool).toBe("IDENTITY_REQUIRED");
      }
      expect(await count("refunds")).toBe(0);
    });

    it("knowing someone's email does not authorize anything", async () => {
      const s = await h.session();
      await s.run("verify_identity", { email: SARAH.email, verificationCode: "999999" });
      expect(errorOf(await s.run("get_subscription", { customerId: "CUST-002" }))?.code).toBe("IDENTITY_REQUIRED");
    });

    it("denies access to another customer's account data", async () => {
      const s = await h.session(SARAH);
      for (const tool of ["get_subscription", "get_contract", "get_payment_history"]) {
        expect(errorOf(await s.run(tool, { customerId: "CUST-001" }))?.code, tool).toBe("ACCESS_DENIED");
      }
      expect((await s.run("get_subscription", { customerId: "CUST-002" })).success).toBe(true);
    });

    it("denies refund checks and refunds on another customer's payment, and does not reveal whether it exists", async () => {
      const s = await h.session(SARAH);
      const other = await s.run("issue_refund", { paymentId: "PAY-001" });
      const missing = await s.run("issue_refund", { paymentId: "PAY-999" });
      expect(errorOf(other)?.code).toBe("ACCESS_DENIED");
      expect(errorOf(missing)).toEqual(errorOf(other));
      expect(errorOf(await s.run("check_refund_eligibility", { paymentId: "PAY-001" }))?.code).toBe("ACCESS_DENIED");
      expect(await count("refunds")).toBe(0);
    });

    it("rejects unknown tools, bad arguments, unknown sessions and runs from another session", async () => {
      const s = await h.session(SARAH);
      expect(errorOf(await s.run("delete_everything", {}))?.code).toBe("TOOL_NOT_FOUND");
      expect(errorOf(await s.run("issue_refund", { paymentId: "drop table" }))?.code).toBe("INVALID_ARGUMENTS");
      const other = await h.session();
      const stolenRun = await h.executor.execute({ tool: "get_subscription", input: {}, sessionId: s.sessionId, runId: other.runId, toolCallId: "x" });
      expect(errorOf(stolenRun)?.code).toBe("SESSION_INVALID");
      const ghost = await h.executor.execute({ tool: "get_subscription", input: {}, sessionId: "ses_nope", runId: s.runId, toolCallId: "y" });
      expect(errorOf(ghost)?.code).toBe("SESSION_INVALID");
    });

    it("rejects an expired session", async () => {
      const s = await h.session(SARAH);
      await pool.query("update sessions set expires_at = now() - interval '1 minute' where id = $1", [s.sessionId]);
      expect(errorOf(await s.run("get_subscription", {}))?.code).toBe("SESSION_INVALID");
    });
  });

  describe("read tools", () => {
    it("returns the verified customer's real subscription, contract and payments", async () => {
      const s = await h.session(SARAH);
      expect(dataOf(await s.run("get_subscription", {}))).toMatchObject({ customerId: "CUST-002", subscription: { tier: "pro", status: "active", monthlyPrice: 49, currency: "USD" } });
      expect(dataOf(await s.run("get_contract", {}))).toMatchObject({ contract: { type: "monthly", status: "active", autoRenew: true } });
      const pay = dataOf<{ payments: Array<{ paymentId: string; refundableCents: number; daysSincePayment: number }> }>(await s.run("get_payment_history", {}));
      expect(pay.payments.map((p) => p.paymentId)).toEqual(["PAY-002", "PAY-007"]);
      expect(pay.payments[0]).toMatchObject({ refundableCents: 4900, daysSincePayment: 2 });
    });

    it("filters knowledge-base results to the verified customer's tier, taken from backend records", async () => {
      const enterprise = await h.session(EMMA);
      const r = dataOf<{ appliedFilters: { tier?: string; contractType?: string }; sources: Array<{ heading: string }> }>(
        await enterprise.run("search_knowledge_base", { query: "What is the refund policy for my subscription?" }),
      );
      expect(r.appliedFilters).toEqual({ tier: "enterprise", contractType: "annual" });
      expect(r.sources[0]?.heading).toBe("Enterprise refund exceptions");
      const anon = await h.session();
      expect(dataOf<{ appliedFilters: object }>(await anon.run("search_knowledge_base", { query: "refund policy" })).appliedFilters).toEqual({});
    });

    it("reports out-of-scope questions as requiresEscalation, not as a failure", async () => {
      const s = await h.session(SARAH);
      const r = await s.run("search_knowledge_base", { query: "Who won the football game last night?" });
      expect(r.success).toBe(true);
      expect(dataOf(r)).toMatchObject({ requiresEscalation: true, sources: [] });
    });
  });

  describe("refund eligibility and execution", () => {
    it("completes an eligible monthly refund and updates the database consistently", async () => {
      const s = await h.session(SARAH);
      expect(dataOf(await s.run("check_refund_eligibility", { paymentId: "PAY-002" }))).toMatchObject({ decision: "eligible", reasonCode: "ELIGIBLE", refundableCents: 4900 });
      const r = await s.run("issue_refund", { paymentId: "PAY-002" });
      expect(dataOf(r)).toMatchObject({ refundId: "REF-001", paymentId: "PAY-002", customerId: "CUST-002", amount: 49, amountCents: 4900, currency: "USD", status: "completed", simulated: true, replayed: false });
      const { rows } = await pool.query("select refunded_cents from payments where id = 'PAY-002'");
      expect(rows[0].refunded_cents).toBe(4900);
      expect(await count("audit_logs", "action = 'refund.issued'")).toBe(1);
    });

    it("rejects a payment outside the refund window", async () => {
      const s = await h.session(SARAH);
      expect(dataOf(await s.run("check_refund_eligibility", { paymentId: "PAY-007" }))).toMatchObject({ decision: "rejected", reasonCode: "REFUND_WINDOW_EXPIRED", daysSincePayment: 35 });
      expect(errorOf(await s.run("issue_refund", { paymentId: "PAY-007" }))).toMatchObject({ code: "REFUND_NOT_ELIGIBLE", retryable: false, details: { reasonCode: "REFUND_WINDOW_EXPIRED" } });
      expect(await count("refunds")).toBe(0);
    });

    it.each([
      ["annual contract", JAMES, "PAY-003", "ANNUAL_CONTRACT"],
      ["Enterprise", EMMA, "PAY-004", "ENTERPRISE_TIER"],
      ["suspended account", OLIVIA, "PAY-006", "ACCOUNT_SUSPENDED"],
    ])("requires human approval for %s", async (_name, who, paymentId, reasonCode) => {
      const s = await h.session(who);
      expect(dataOf(await s.run("check_refund_eligibility", { paymentId }))).toMatchObject({ decision: "manual_approval_required", reasonCode });
      expect(errorOf(await s.run("issue_refund", { paymentId }))).toMatchObject({ code: "MANUAL_APPROVAL_REQUIRED", details: { reasonCode } });
      expect(await count("refunds")).toBe(0);
    });

    it("rejects an expired customer's old payment", async () => {
      const s = await h.session({ email: "daniel.brown@example.com", code: "268471" });
      expect(dataOf(await s.run("check_refund_eligibility", { paymentId: "PAY-005" }))).toMatchObject({ decision: "rejected", reasonCode: "REFUND_WINDOW_EXPIRED" });
    });

    it("rejects amounts above the balance and partial refunds", async () => {
      const s = await h.session(SARAH);
      expect(errorOf(await s.run("issue_refund", { paymentId: "PAY-002", amountCents: 9999 }))?.details).toMatchObject({ reasonCode: "AMOUNT_EXCEEDS_BALANCE" });
      expect(errorOf(await s.run("issue_refund", { paymentId: "PAY-002", amountCents: 1000 }))?.details).toMatchObject({ reasonCode: "PARTIAL_REFUND_NOT_SUPPORTED" });
      expect(await count("refunds")).toBe(0);
    });

    it("escalates when no refund policy is available (missing policy)", async () => {
      const noPolicy = buildHarness({ policy: { available: false, sources: [] } });
      const s = await noPolicy.session(SARAH);
      expect(dataOf(await s.run("check_refund_eligibility", { paymentId: "PAY-002" }))).toMatchObject({ decision: "escalate", reasonCode: "POLICY_NOT_FOUND" });
      expect(errorOf(await s.run("issue_refund", { paymentId: "PAY-002" }))?.code).toBe("POLICY_NOT_FOUND");
      expect(await count("refunds")).toBe(0);
    });

    it("uses the real Phase 2 retrieval to find the applicable policy", async () => {
      const s = await h.session(SARAH);
      const r = dataOf<{ policySources: Array<{ document: string; heading: string }> }>(await s.run("check_refund_eligibility", { paymentId: "PAY-002" }));
      // The top evidence must be the refund policy (lower-ranked sources may legitimately come from other documents).
      expect(r.policySources[0]?.document).toBe("refund-policy.md");
    });
  });

  describe("idempotency and concurrency", () => {
    it("returns the original refund for a duplicate request in the same session", async () => {
      const s = await h.session(SARAH);
      const first = dataOf<{ refundId: string; replayed: boolean }>(await s.run("issue_refund", { paymentId: "PAY-002" }));
      const second = dataOf<{ refundId: string; replayed: boolean }>(await s.run("issue_refund", { paymentId: "PAY-002" }));
      expect(first.replayed).toBe(false);
      expect(second).toMatchObject({ refundId: first.refundId, replayed: true });
      expect(await count("refunds")).toBe(1);
    });

    it("rejects a second refund for the same payment from a different session", async () => {
      await (await h.session(SARAH)).run("issue_refund", { paymentId: "PAY-002" });
      const again = await h.session(SARAH);
      expect(dataOf(await again.run("check_refund_eligibility", { paymentId: "PAY-002" }))).toMatchObject({ decision: "rejected", reasonCode: "ALREADY_REFUNDED" });
      expect(errorOf(await again.run("issue_refund", { paymentId: "PAY-002" }))).toMatchObject({ code: "REFUND_NOT_ELIGIBLE", details: { reasonCode: "ALREADY_REFUNDED" } });
      expect(await count("refunds")).toBe(1);
    });

    it("refuses to reuse an idempotency key for a different refund", async () => {
      const s = await h.session(SARAH);
      await s.run("issue_refund", { paymentId: "PAY-002" }, { idempotencyKey: "k1" });
      expect(errorOf(await s.run("issue_refund", { paymentId: "PAY-007" }, { idempotencyKey: "k1" }))?.code).toBe("IDEMPOTENCY_CONFLICT");
    });

    it("creates exactly one refund when ten sessions refund the same payment at once", async () => {
      const sessions = await Promise.all(Array.from({ length: 10 }, () => h.session(SARAH)));
      const results = await Promise.all(sessions.map((s) => s.run("issue_refund", { paymentId: "PAY-002" })));
      expect(results.filter((r) => r.success)).toHaveLength(1);
      for (const r of results.filter((r) => !r.success)) expect(errorOf(r)).toMatchObject({ code: "REFUND_NOT_ELIGIBLE", details: { reasonCode: "ALREADY_REFUNDED" } });
      expect(await count("refunds")).toBe(1);
      const { rows } = await pool.query("select refunded_cents, amount_cents from payments where id = 'PAY-002'");
      expect(rows[0].refunded_cents).toBe(rows[0].amount_cents);
    });

    it("returns one refund to ten concurrent identical requests (same idempotency key)", async () => {
      const s = await h.session(SARAH);
      const results = await Promise.all(Array.from({ length: 10 }, () => s.run("issue_refund", { paymentId: "PAY-002" })));
      expect(results.every((r) => r.success)).toBe(true);
      expect(new Set(results.map((r) => dataOf<{ refundId: string }>(r).refundId)).size).toBe(1);
      expect(await count("refunds")).toBe(1);
    });

    it("does not deadlock when concurrent refunds outnumber the pool's connections", { timeout: 20_000 }, async () => {
      // Regression: the transaction used to query the shared pool while holding a client, so with every
      // connection blocked on the payment row lock the lock holder could never get one.
      const small = buildHarness({ poolMax: 3 });
      try {
        const sessions = await Promise.all(Array.from({ length: 12 }, () => small.session(SARAH)));
        const results = await Promise.all(sessions.map((s) => s.run("issue_refund", { paymentId: "PAY-002" })));
        expect(results.filter((r) => r.success)).toHaveLength(1);
        expect(results.filter((r) => !r.success).every((r) => errorOf(r)?.details?.reasonCode === "ALREADY_REFUNDED")).toBe(true);
        expect(await count("refunds")).toBe(1);
      } finally {
        await small.close();
      }
    });

    it("the database itself blocks over-refunding even if application checks were bypassed", async () => {
      await expect(pool.query("update payments set refunded_cents = amount_cents + 1 where id = 'PAY-002'")).rejects.toMatchObject({ code: "23514" });
      await pool.query("insert into refunds (payment_id, customer_id, amount_cents, idempotency_key) values ('PAY-002','CUST-002',4900,'raw-1')");
      await expect(pool.query("insert into refunds (payment_id, customer_id, amount_cents, idempotency_key) values ('PAY-002','CUST-002',4900,'raw-2')")).rejects.toMatchObject({ code: "23505" });
    });
  });

  describe("failure recovery", () => {
    it("recovers the existing refund when the call fails right after the commit", async () => {
      h.simulator.arm("issue_refund", "after_commit", 1);
      const s = await h.session(SARAH);
      const r = await s.run("issue_refund", { paymentId: "PAY-002" });
      expect(r.success).toBe(true);
      expect(r.metadata.attempts).toBe(2);
      expect(dataOf(r)).toMatchObject({ refundId: "REF-001", replayed: true });
      expect(await count("refunds")).toBe(1);
    });

    it("recovers the existing refund when the response is lost to a timeout after the commit", async () => {
      const fast = buildHarness({ timeoutOverrideMs: 600 });
      fast.simulator.arm("issue_refund", "timeout_after_commit", 1);
      const s = await fast.session(SARAH);
      const r = await s.run("issue_refund", { paymentId: "PAY-002" });
      expect(r.success).toBe(true);
      expect(r.metadata.attempts).toBe(2);
      expect(dataOf(r)).toMatchObject({ refundId: "REF-001", replayed: true });
      expect(await count("refunds")).toBe(1);
    });

    it("retries a timeout that happened before anything was committed", async () => {
      const fast = buildHarness({ timeoutOverrideMs: 600 });
      fast.simulator.arm("issue_refund", "timeout", 1);
      const s = await fast.session(SARAH);
      const r = await s.run("issue_refund", { paymentId: "PAY-002" });
      expect(r.success).toBe(true);
      expect(dataOf(r)).toMatchObject({ replayed: false });
      expect(await count("refunds")).toBe(1);
    });

    it("retries a temporary tool failure and succeeds", async () => {
      h.simulator.arm("get_subscription", "db_temporary", 2);
      const s = await h.session(SARAH);
      const r = await s.run("get_subscription", {});
      expect(r.success).toBe(true);
      expect(r.metadata.attempts).toBe(3);
    });

    it("is bounded: a failure that never clears returns a retryable structured error", async () => {
      h.simulator.arm("get_subscription", "db_temporary", 99);
      const s = await h.session(SARAH);
      const r = await s.run("get_subscription", {});
      expect(r.success).toBe(false);
      expect(r.metadata.attempts).toBe(3); // 1 try + 2 retries
      expect(errorOf(r)).toMatchObject({ code: "DATABASE_UNAVAILABLE", retryable: true });
    });

    it("returns a structured, non-retried failure for a permanent tool failure", async () => {
      h.simulator.arm("get_subscription", "permanent");
      const s = await h.session(SARAH);
      const r = await s.run("get_subscription", {});
      expect(errorOf(r)).toMatchObject({ code: "SIMULATED_FAILURE", retryable: false });
      expect(r.metadata.attempts).toBe(1);
    });

    it("never throws and never leaks internals when a tool crashes", async () => {
      const s = await h.session(SARAH);
      await pool.query("alter table subscriptions rename to subscriptions_x");
      try {
        const r = await s.run("get_subscription", {});
        expect(errorOf(r)).toMatchObject({ code: "INTERNAL_ERROR", retryable: false });
        expect(JSON.stringify(r)).not.toMatch(/subscriptions_x|relation|syntax/i);
      } finally {
        await pool.query("alter table subscriptions_x rename to subscriptions");
      }
    });
  });

  describe("account updates", () => {
    it("updates permitted fields and audits previous and new values", async () => {
      const s = await h.session(SARAH);
      expect(dataOf(await s.run("update_account", { field: "displayName", value: "  Sarah W.  " }))).toMatchObject({ field: "displayName", previousValue: "Sarah Wilson", newValue: "Sarah W.", changed: true });
      await s.run("update_account", { field: "timezone", value: "America/New_York" });
      await s.run("update_account", { field: "language", value: "es" });
      await s.run("update_account", { field: "notificationPreferences", value: { sms: true } });
      const { rows } = await pool.query("select display_name, timezone, language, notification_preferences from customers where id = 'CUST-002'");
      expect(rows[0]).toEqual({ display_name: "Sarah W.", timezone: "America/New_York", language: "es", notification_preferences: { email: true, sms: true, marketing: false } });
      const audits = await pool.query("select action, previous_value, new_value from audit_logs where entity_id = 'CUST-002' and action like 'account.%' order by id");
      expect(audits.rows.map((a) => a.action)).toEqual(["account.displayName.updated", "account.timezone.updated", "account.language.updated", "account.notificationPreferences.updated"]);
      expect(audits.rows[0]).toMatchObject({ previous_value: "Sarah Wilson", new_value: "Sarah W." });
    });

    it("is idempotent: repeating the same update changes and audits nothing", async () => {
      const s = await h.session(SARAH);
      await s.run("update_account", { field: "language", value: "fr" });
      expect(dataOf(await s.run("update_account", { field: "language", value: "fr" }))).toMatchObject({ changed: false });
      expect(await count("audit_logs", "action = 'account.language.updated'")).toBe(1);
    });

    it.each(["tier", "subscriptionTier", "accountBalance", "password", "customerId", "adminPermissions", "email", "status", "verification_code_hash"])(
      "rejects the restricted field %s",
      async (field) => {
        const s = await h.session(SARAH);
        expect(errorOf(await s.run("update_account", { field, value: "enterprise" }))?.code).toBe("ACCESS_DENIED");
        const { rows } = await pool.query("select email, status from customers where id = 'CUST-002'");
        expect(rows[0]).toEqual({ email: "sarah@example.com", status: "active" });
        expect(await count("subscriptions", "customer_id = 'CUST-002' and tier = 'pro'")).toBe(1);
      },
    );

    it("sends a billing email change to a human instead of changing it", async () => {
      const s = await h.session(SARAH);
      expect(errorOf(await s.run("update_account", { field: "billingEmail", value: "attacker@example.com" }))?.code).toBe("MANUAL_APPROVAL_REQUIRED");
      const { rows } = await pool.query("select billing_email from customers where id = 'CUST-002'");
      expect(rows[0].billing_email).toBeNull();
    });

    it.each([
      ["timezone", "Mars/Olympus"],
      ["language", "klingon"],
      ["displayName", ""],
      ["displayName", "bad\u0000name"],
      ["notificationPreferences", { pager: true }],
    ])("validates the value for %s", async (field, value) => {
      const s = await h.session(SARAH);
      expect(errorOf(await s.run("update_account", { field, value }))?.code).toBe("INVALID_ARGUMENTS");
    });
  });

  describe("escalation tickets", () => {
    it("creates a persistent structured ticket with the tools executed so far", async () => {
      const s = await h.session(EMMA);
      await s.run("check_refund_eligibility", { paymentId: "PAY-004" });
      const r = await s.run("create_escalation_ticket", {
        reason: "MANUAL_APPROVAL_REQUIRED", category: "refund", summary: "Enterprise customer requests a refund.",
        inquiry: "I would like a refund for last invoice.", policyReferences: [{ document: "refund-policy.md", heading: "Enterprise refund exceptions" }],
      });
      expect(dataOf(r)).toMatchObject({ ticketId: "TKT-001", customerId: "CUST-004", category: "refund", priority: "high", reason: "MANUAL_APPROVAL_REQUIRED", status: "open" });
      const { rows } = await pool.query("select * from escalation_tickets where id = 'TKT-001'");
      expect(rows[0]).toMatchObject({ session_id: s.sessionId, run_id: s.runId, inquiry: "I would like a refund for last invoice." });
      expect(rows[0].policy_references).toEqual([{ document: "refund-policy.md", heading: "Enterprise refund exceptions" }]);
      expect(rows[0].completed_tool_executions.map((t: { tool: string }) => t.tool)).toEqual(["verify_identity", "check_refund_eligibility"]);
    });

    it("works without verification (e.g. identity failed) and does not duplicate on retry", async () => {
      const s = await h.session();
      const input = { reason: "IDENTITY_FAILED", category: "account", summary: "Customer could not verify." };
      const a = dataOf<{ ticketId: string }>(await s.run("create_escalation_ticket", input));
      const b = dataOf<{ ticketId: string; replayed: boolean }>(await s.run("create_escalation_ticket", input));
      expect(b).toMatchObject({ ticketId: a.ticketId, replayed: true });
      expect(await count("escalation_tickets")).toBe(1);
      expect((await pool.query("select customer_id from escalation_tickets")).rows[0].customer_id).toBeNull();
    });

    it("creates exactly one ticket when the call fails after the commit and is retried", async () => {
      h.simulator.arm("create_escalation_ticket", "after_commit", 1);
      const s = await h.session(SARAH);
      const r = await s.run("create_escalation_ticket", { reason: "LOW_CONFIDENCE", category: "technical", summary: "Not covered by policy." });
      expect(r.success).toBe(true);
      expect(r.metadata.attempts).toBe(2);
      expect(await count("escalation_tickets")).toBe(1);
    });

    it("validates input", async () => {
      const s = await h.session();
      expect(errorOf(await s.run("create_escalation_ticket", { reason: "BECAUSE", category: "refund", summary: "x" }))?.code).toBe("INVALID_ARGUMENTS");
    });
  });

  describe("lifecycle, logs and events", () => {
    it("emits started then completed/failed events with increasing sequence numbers", async () => {
      const s = await h.session(SARAH);
      const seen: Array<{ type: string; tool: string; seq: number; status?: string }> = [];
      const sub = h.events.ofRun(s.runId).subscribe((e) => seen.push({ type: e.type, tool: e.data.tool, seq: e.seq, status: e.data.status }));
      await s.run("get_subscription", {});
      await s.run("issue_refund", { paymentId: "PAY-001" });
      sub.unsubscribe();
      expect(seen.map((e) => `${e.type}:${e.tool}`)).toEqual(["tool.started:get_subscription", "tool.completed:get_subscription", "tool.started:issue_refund", "tool.failed:issue_refund"]);
      // seq is per run: verify_identity (setup) already used 1 and 2.
      expect(seen.map((e) => e.seq)).toEqual([3, 4, 5, 6]);
      expect(seen[1]?.status).toBe("success");
    });

    it("persists every execution, successful or not, with duration and error code", async () => {
      const s = await h.session(SARAH);
      const ok = await s.run("get_subscription", {});
      const bad = await s.run("issue_refund", { paymentId: "PAY-001" });
      const { rows } = await pool.query("select id, tool, status, error_code, attempts, duration_ms from tool_executions where run_id = $1 order by created_at", [s.runId]);
      expect(rows.map((r) => [r.tool, r.status, r.error_code])).toEqual([["verify_identity", "success", null], ["get_subscription", "success", null], ["issue_refund", "failed", "ACCESS_DENIED"]]);
      expect(rows[1].id).toBe(ok.metadata.executionId);
      expect(rows[2].id).toBe(bad.metadata.executionId);
      expect(ok.metadata).toMatchObject({ attempts: 1 });
      expect(new Date(ok.metadata.executedAt).getTime()).not.toBeNaN();
    });

    it("describes all nine tools with JSON Schemas for the Phase 4 orchestrator", () => {
      const described = h.registry.describe();
      expect(described.map((t) => t.name).sort()).toEqual([
        "check_refund_eligibility", "create_escalation_ticket", "get_contract", "get_payment_history", "get_subscription",
        "issue_refund", "search_knowledge_base", "update_account", "verify_identity",
      ]);
      expect(described.find((t) => t.name === "issue_refund")).toMatchObject({ type: "write", requiresIdentity: true, parameters: { type: "object" } });
    });
  });

  describe("complete workflow (spec section 9)", () => {
    it("Pro customer requests a $49 refund: 7 successful tool executions, refund committed", async () => {
      const s = await h.session();
      const steps: Array<[string, unknown]> = [
        ["verify_identity", { email: SARAH.email, verificationCode: SARAH.code }],
        ["get_subscription", {}],
        ["get_contract", {}],
        ["get_payment_history", {}],
        ["search_knowledge_base", { query: "What is the refund policy for my subscription?" }],
        ["check_refund_eligibility", { paymentId: "PAY-002" }],
        ["issue_refund", { paymentId: "PAY-002" }],
      ];
      const results = [];
      for (const [tool, input] of steps) results.push(await s.run(tool, input));
      expect(results.map((r) => r.success)).toEqual(Array(7).fill(true));
      expect(dataOf(results[6]!)).toMatchObject({ refundId: "REF-001", amount: 49 });
      expect(await count("tool_executions", "run_id = $1 and status = 'success'", [s.runId])).toBe(7);
      expect(await count("refunds")).toBe(1);
    });
  });
});
