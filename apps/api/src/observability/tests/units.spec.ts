import { describe, expect, it } from "vitest";
import { classifyError } from "../errors/error-classifier.js";
import { TelemetryWriter } from "../persistence/telemetry-writer.js";
import { PricingRegistry, formatUsd, pricingRegistry } from "../pricing/pricing-registry.js";
import { sanitize, sanitizeDetail, sanitizeString } from "../privacy/telemetry-sanitizer.js";
import { estimateTokens, normalizeUsage } from "../usage/usage-normalizer.js";

describe("usage normalization (no double counting)", () => {
  it("treats cached tokens as a subset of the prompt", () => {
    const u = normalizeUsage({ promptTokens: 1000, cachedTokens: 400, outputTokens: 200 });
    expect(u).toMatchObject({ inputTextTokens: 600, cachedInputTokens: 400, outputTextTokens: 200, totalTokens: 1200 });
  });
  it("does not add thinking tokens again when the provider already counts them in the output", () => {
    expect(normalizeUsage({ promptTokens: 100, outputTokens: 300, thinkingTokens: 120, thinkingIncludedInOutput: true }).totalTokens).toBe(400);
  });
  it("bills separately reported thinking tokens as output", () => {
    const u = normalizeUsage({ promptTokens: 100, outputTokens: 300, thinkingTokens: 120, thinkingIncludedInOutput: false });
    expect(u.outputTextTokens).toBe(420);
    expect(u.totalTokens).toBe(520);
  });
  it("splits audio from text for Live usage and never lets a subset exceed its parent", () => {
    const u = normalizeUsage({ promptTokens: 1500, audioInputTokens: 1200, outputTokens: 900, audioOutputTokens: 700 });
    expect(u).toMatchObject({ inputTextTokens: 300, inputAudioTokens: 1200, outputTextTokens: 200, outputAudioTokens: 700, totalTokens: 2400 });
    expect(normalizeUsage({ promptTokens: 10, cachedTokens: 50 }).cachedInputTokens).toBe(10);
  });
  it("is explicit when usage is unavailable, and labels estimates", () => {
    expect(normalizeUsage(null)).toMatchObject({ usageSource: "unavailable", totalTokens: 0 });
    expect(normalizeUsage({ promptTokens: estimateTokens(400) }, "estimated").usageSource).toBe("estimated");
  });
});

describe("pricing registry", () => {
  const u = normalizeUsage({ promptTokens: 1000, cachedTokens: 400, outputTokens: 200 });

  it("computes C = sum(tokens x price) / 1,000,000 per bucket", () => {
    const c = pricingRegistry.estimate("gpt-4.1-mini", u, new Date("2026-12-01"));
    expect(c.status).toBe("ok");
    if (c.status === "ok") {
      expect(formatUsd(c.usd)).toBe("0.000600"); // 600*0.4 + 400*0.1 + 200*1.6 per million
      expect(c.pricingVersion).toBe("gpt-4.1-mini@2026-11-25");
    }
  });
  it("uses the price that applied on that day, so history stays reproducible", () => {
    const base = { provider: "openai", model: "m", currency: "USD", sourceUrl: "https://x", verifiedOn: "2026-11-25" } as const;
    const reg = new PricingRegistry([
      { ...base, inputTextPerMillion: 0.75, outputTextPerMillion: 3.75, cachedInputPerMillion: 0.075, effectiveFrom: "2026-11-25", effectiveUntil: "2027-01-01" },
      { ...base, inputTextPerMillion: 1.5, outputTextPerMillion: 7.5, cachedInputPerMillion: 0.15, effectiveFrom: "2027-01-01" },
    ]);
    const before = reg.estimate("m", u, new Date("2026-12-31"));
    const after = reg.estimate("m", u, new Date("2027-01-01"));
    if (before.status !== "ok" || after.status !== "ok") throw new Error("expected prices");
    expect(formatUsd(after.usd)).toBe("0.002460"); // the 2027 rates are exactly double
    expect(after.snapshot.effectiveFrom).toBe("2027-01-01");
    expect(before.snapshot.effectiveUntil).toBe("2027-01-01");
  });
  it("reports cost as unavailable, never zero, for an unknown model or a date before any entry", () => {
    expect(pricingRegistry.estimate("gpt-unknown-9", u)).toMatchObject({ status: "unavailable" });
    expect(pricingRegistry.estimate("gpt-4.1-mini", u, new Date("2020-01-01"))).toMatchObject({ status: "unavailable" });
  });
  it("is unavailable when tokens fall in a bucket with no configured rate (no silent partial sum)", () => {
    const audio = normalizeUsage({ promptTokens: 100, audioInputTokens: 100, outputTokens: 10 });
    const c = pricingRegistry.estimate("gpt-4.1-mini", audio, new Date("2026-12-01"));
    expect(c).toMatchObject({ status: "unavailable" });
    expect(c.status === "unavailable" && c.reason).toMatch(/input audio/);
  });
  it("prices Realtime audio and embeddings", () => {
    const live = normalizeUsage({ promptTokens: 1500, audioInputTokens: 1200, outputTokens: 900, audioOutputTokens: 700 });
    const c = pricingRegistry.estimate("gpt-realtime-mini", live, new Date("2026-12-01"));
    expect(c.status === "ok" && formatUsd(c.usd)).toBe("0.026660"); // 300*.6 + 1200*10 + 200*2.4 + 700*20 per million
    const e = pricingRegistry.estimate("text-embedding-3-small", normalizeUsage(null), new Date("2026-12-01"), { embeddingTokens: 2000 });
    expect(e.status === "ok" && formatUsd(e.usd)).toBe("0.000040");
  });
  it("a failed call with no usage is unavailable", () => {
    expect(pricingRegistry.estimate("gpt-4.1-mini", normalizeUsage(null))).toMatchObject({ status: "unavailable" });
  });
  it("every entry names its source and verification date", () => {
    for (const p of new PricingRegistry().all()) expect([p.sourceUrl.startsWith("https://"), Boolean(p.verifiedOn), Boolean(p.effectiveFrom)]).toEqual([true, true, true]);
  });
});

describe("telemetry sanitizer", () => {
  it("removes verification codes, keys, bearer tokens and connection strings", () => {
    const out = sanitizeString("code 482910, key AIzaSyA1234567890abcdefghijklmnopqrstuvw, Authorization: Bearer abcdef123456789, postgres://u:p@h:5433/db");
    expect(out).not.toMatch(/482910|AIzaSy|abcdef123456789|postgres:\/\//);
  });
  it("masks emails but keeps ids and amounts readable", () => {
    expect(sanitizeString("sarah@example.com paid $49.00 for PAY-002")).toBe("s***@example.com paid $49.00 for PAY-002");
  });
  it("redacts secret-named fields at any depth and never emits stack traces", () => {
    const out = sanitize({ args: { verificationCode: "482910", nested: { apiKey: "x", resumptionHandle: "h", ticket: "t", fine: 1 } }, err: new Error("boom 482910") }) as any;
    expect(out.args.verificationCode).toBe("[redacted]");
    expect(out.args.nested).toEqual({ apiKey: "[redacted]", resumptionHandle: "[redacted]", ticket: "[redacted]", fine: 1 });
    expect(out.err).toEqual({ name: "Error", message: "boom [CODE]" });
  });
  it("bounds string, depth and size", () => {
    expect(sanitizeString("a".repeat(5000)).length).toBeLessThan(4100);
    expect(JSON.stringify(sanitizeDetail({ big: "x".repeat(100_000) })).length).toBeLessThan(26_000);
  });
});

describe("error classification", () => {
  it("separates correctly enforced business rules from infrastructure failures", () => {
    expect(classifyError("ACCESS_DENIED")).toEqual({ category: "authorization", kind: "business_rule" });
    expect(classifyError("REFUND_NOT_ELIGIBLE").kind).toBe("business_rule");
    expect(classifyError("TOOL_TIMEOUT")).toEqual({ category: "timeout", kind: "infrastructure" });
    expect(classifyError("LLM_RATE_LIMIT").category).toBe("rate_limit");
    expect(classifyError("LLM_UNAVAILABLE").category).toBe("provider");
    expect(classifyError("INVALID_ARGUMENTS").category).toBe("validation");
    expect(classifyError("RETRIEVAL_FAILED").category).toBe("retrieval");
  });
});

describe("telemetry writer", () => {
  const span = (i: number) => ({ t: "span" as const, row: { spanId: `s${i}`, traceId: "t", parentSpanId: null, runId: null, sessionId: null, voiceSessionId: null, name: "x", category: "agent", startedAt: new Date(), durationMs: 1, status: "ok" as const, errorCode: null, attributes: {}, detail: undefined } });

  it("bounds its queue and counts what it drops instead of growing", () => {
    const w = new TelemetryWriter({} as never, { maxQueue: 100, flushMs: 1000 });
    for (let i = 0; i < 5000; i++) w.enqueue(span(i));
    expect(w.queued).toBe(100);
    expect(w.dropped).toBe(4900);
  });
  it("reports degraded observability when the database fails, never throws, and recovers", async () => {
    let failing = true;
    const client = { query: async () => ({}), release() {} };
    const pool = { connect: async () => { if (failing) throw new Error("db down"); return client; } };
    const w = new TelemetryWriter(pool as never, { maxQueue: 10, flushMs: 1000 });
    w.enqueue(span(1));
    await expect(w.flush()).resolves.toBeUndefined();
    expect(w.status()).toMatchObject({ degraded: true, dropped: 1, lastError: "db down" });
    failing = false;
    w.enqueue(span(2));
    await w.flush();
    expect(w.status()).toMatchObject({ degraded: false, written: 1 });
  });
});
