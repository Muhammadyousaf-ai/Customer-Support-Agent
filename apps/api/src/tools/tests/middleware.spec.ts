import { describe, expect, it, vi } from "vitest";
import type { ToolResult } from "@support-ai/contracts";
import { ToolError, toErrorInfo } from "../errors/tool-error.js";
import { IdempotencyService } from "../middleware/idempotency.service.js";
import { RetryService } from "../middleware/retry.service.js";
import { TimeoutService } from "../middleware/timeout.service.js";
import { redact } from "../registry/tool-executor.service.js";
import { FailureSimulator } from "../simulation/failure-simulator.service.js";
import { loadEnv } from "../../config/env.js";
import { fail, ok } from "../types/tool-result.js";

const retry = new RetryService();

describe("RetryService", () => {
  it("retries retryable failures and stops on success", async () => {
    const fn = vi.fn<(n: number) => Promise<ToolResult<string>>>(async (n) => (n < 3 ? fail("DATABASE_UNAVAILABLE", "x", true) : ok("done")));
    const { result, attempts } = await retry.run(fn, { maxRetries: 2, baseDelayMs: 0 });
    expect(result.success).toBe(true);
    expect(attempts).toBe(3);
  });
  it("is bounded: gives up after maxRetries and returns the last error", async () => {
    const fn = vi.fn(async () => fail<string>("DATABASE_UNAVAILABLE", "x", true));
    const { result, attempts } = await retry.run(fn, { maxRetries: 2, baseDelayMs: 0 });
    expect(attempts).toBe(3);
    expect(result.error).toMatchObject({ code: "DATABASE_UNAVAILABLE", retryable: true });
  });
  it("never retries a non-retryable failure", async () => {
    const fn = vi.fn(async () => fail<string>("ACCESS_DENIED", "no"));
    const { attempts } = await retry.run(fn, { maxRetries: 5, baseDelayMs: 0 });
    expect(attempts).toBe(1);
  });
});

describe("TimeoutService", () => {
  it("rejects with a retryable TOOL_TIMEOUT and aborts the signal", async () => {
    let aborted = false;
    const p = new TimeoutService().run(20, (signal) => new Promise<never>((_, rej) => { signal.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); }); }));
    await expect(p).rejects.toMatchObject({ code: "TOOL_TIMEOUT", retryable: true });
    expect(aborted).toBe(true);
  });
  it("passes through a fast result", async () => {
    await expect(new TimeoutService().run(1000, async () => 7)).resolves.toBe(7);
  });
});

describe("IdempotencyService", () => {
  const svc = new IdempotencyService();
  const call = (over = {}) => ({ tool: "issue_refund", input: {}, sessionId: "ses_1", runId: "r", toolCallId: "c", ...over });
  it("derives the same key for the same logical request regardless of property order", () => {
    expect(svc.keyFor(call(), "issue_refund", { paymentId: "PAY-1", amountCents: 100 })).toBe(svc.keyFor(call({ toolCallId: "other" }), "issue_refund", { amountCents: 100, paymentId: "PAY-1" }));
  });
  it("differs by session, tool and arguments", () => {
    const base = svc.keyFor(call(), "issue_refund", { paymentId: "PAY-1" });
    expect(svc.keyFor(call({ sessionId: "ses_2" }), "issue_refund", { paymentId: "PAY-1" })).not.toBe(base);
    expect(svc.keyFor(call(), "update_account", { paymentId: "PAY-1" })).not.toBe(base);
    expect(svc.keyFor(call(), "issue_refund", { paymentId: "PAY-2" })).not.toBe(base);
  });
  it("namespaces a caller-provided key to the session", () => {
    expect(svc.keyFor(call({ idempotencyKey: "abc" }), "issue_refund", {})).toBe("ses_1:issue_refund:abc");
  });
});

describe("error normalisation", () => {
  it("keeps tool errors and maps connection errors to a retryable DATABASE_UNAVAILABLE", () => {
    expect(toErrorInfo(new ToolError("ACCESS_DENIED", "no"))).toMatchObject({ code: "ACCESS_DENIED", retryable: false });
    expect(toErrorInfo(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toMatchObject({ code: "DATABASE_UNAVAILABLE", retryable: true });
    expect(toErrorInfo(Object.assign(new Error("x"), { code: "57P01" }))).toMatchObject({ code: "DATABASE_UNAVAILABLE", retryable: true });
  });
  it("hides the details of unexpected errors", () => {
    const info = toErrorInfo(new Error("password=hunter2 connection string leaked"));
    expect(info).toMatchObject({ code: "INTERNAL_ERROR", retryable: false });
    expect(JSON.stringify(info)).not.toContain("hunter2");
  });
});

describe("redact", () => {
  it("removes verification codes and passwords, including nested ones", () => {
    expect(redact({ email: "a@b.c", verificationCode: "123456", nested: { password: "x", ok: 1 } })).toEqual({ email: "a@b.c", verificationCode: "[redacted]", nested: { password: "[redacted]", ok: 1 } });
  });
});

describe("FailureSimulator", () => {
  it("is disabled in production", () => {
    const sim = new FailureSimulator(loadEnv({ NODE_ENV: "production", DATABASE_URL: "postgres://app:pw@db.example.com/app", WEB_ORIGIN: "https://app.example.com", ADMIN_API_KEY: "0123456789abcdefghij", OPENAI_API_KEY: "k", JWT_SECRET: "a-long-random-production-secret-0123456789" }));
    expect(sim.enabled).toBe(false);
    expect(() => sim.arm("issue_refund", "permanent")).toThrow(/disabled in production/);
  });
  it("can be armed from the environment", async () => {
    const sim = new FailureSimulator(loadEnv({ SIMULATE_TOOL_FAILURE: "get_subscription:db_temporary:1" }));
    const signal = new AbortController().signal;
    await expect(sim.beforeExecute("get_subscription", signal)).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE", retryable: true });
    await expect(sim.beforeExecute("get_subscription", signal)).resolves.toBeUndefined();
  });
});
