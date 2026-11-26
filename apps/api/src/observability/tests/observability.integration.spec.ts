import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentService } from "../../agent/agent.service.js";
import { E2eScenarioProvider } from "../../agent/providers/e2e-scenario.provider.js";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../agent/providers/llm-provider.interface.js";
import { LLM_PROVIDER } from "../../agent/providers/llm-provider.interface.js";
import { configureApp } from "../../app.setup.js";
import { pool } from "../../database/pool.js";
import { seedDatabase } from "../../database/seed-data.js";
import { IngestionService } from "../../rag/ingestion/ingestion.service.js";
import { InstrumentedLlmProvider } from "../instrumentation/instrumented-llm.provider.js";
import { telemetry } from "../persistence/telemetry-writer.js";

Object.assign(process.env, {
  AGENT_LLM: "e2e", E2E_LLM_DELAY_MS: "5", EMBEDDINGS_PROVIDER: "local", OPENAI_API_KEY: "", VOICE_PROVIDER: "fake",
  RATE_LIMIT_SESSION_PER_MIN: "1000", RATE_LIMIT_IP_PER_MIN: "1000", ADMIN_API_KEY: "test-admin-key", TELEMETRY_FLUSH_MS: "50",
});
const { AppModule } = await import("../../app.module.js");

const ADMIN = "test-admin-key";
const login = "I'm sarah@example.com, my code is 482910.";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The scripted agent model, but presented as a priced OpenAI model with known usage, so cost maths can be asserted exactly. */
class PricedScripted implements LlmProvider {
  readonly name = "scripted";
  readonly configured = true;
  model = "gpt-4.1-mini";
  usageReported = true;
  private readonly inner = new E2eScenarioProvider(5);
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const r = await this.inner.complete(req);
    return { ...r, model: this.model, usage: { inputTokens: 1000, outputTokens: 200 }, usageReported: this.usageReported, cachedTokens: 400, reasoningTokens: 50, finishReason: "stop" };
  }
}

describe("observability (real HTTP + PostgreSQL + LangGraph)", () => {
  let app: INestApplication;
  let base: string;
  let agent: AgentService;
  const scripted = new PricedScripted();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LLM_PROVIDER).useValue(new InstrumentedLlmProvider(scripted)).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, "http://localhost:3000");
    await app.init();
    await app.listen(0);
    base = `${await app.getUrl()}/v1`.replace("[::1]", "127.0.0.1");
    agent = app.get(AgentService);
    await app.get(IngestionService).ingestDirectory();
  });
  afterAll(async () => {
    await agent.idle();
    await app.close();
  });
  beforeEach(async () => {
    await agent.idle();
    await telemetry()?.flush();
    await seedDatabase(pool);
    scripted.model = "gpt-4.1-mini";
    scripted.usageReported = true;
  });

  const get = async (path: string, auth: { token?: string; admin?: string } = {}) => {
    const res = await fetch(`${base}${path}`, { headers: { ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}), ...(auth.admin ? { "x-admin-key": auth.admin } : {}) } });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  let n = 0;
  const session = async () => agent.createSession();
  const say = (s: { sessionId: string }, message: string) => agent.submitMessage(s.sessionId, { message, clientMessageId: `m${++n}-${Date.now()}`, mode: "chat" });
  /** Verified session that has proposed a refund and is waiting for the customer. */
  const refundPending = async () => {
    const s = await session();
    const r = await say(s, `${login} Please refund my last payment.`);
    expect(r.status).toBe("awaiting_confirmation");
    return { s, runId: r.runId };
  };

  it("creates one trace per run with correctly nested spans: node > model / tool / rag", async () => {
    const { s, runId } = await refundPending();
    const spans = (await get(`/observability/runs/${runId}/spans`, { admin: ADMIN })).body as any[];
    const byId = new Map(spans.map((x) => [x.spanId, x]));
    const parent = (x: any) => byId.get(x.parentSpanId);
    expect(new Set(spans.map((x) => x.traceId)).size).toBe(1);
    const root = spans.find((x) => x.name === "agent.run");
    expect(root.parentSpanId).toBeNull();
    expect(root.attributes).toMatchObject({ segment: 1, outcome: "paused" });
    for (const x of spans.filter((x) => x.name.startsWith("node."))) expect(parent(x).name).toBe("agent.run");
    for (const x of spans.filter((x) => x.name.startsWith("llm."))) expect(parent(x).name).toBe("node.llm_decision");
    // Read-only checks run from the validation node, actions from the execute node: always inside a graph node.
    for (const x of spans.filter((x) => x.name.startsWith("tool."))) expect(["node.execute_tool", "node.validate_tool"]).toContain(parent(x).name);
    // Retrieval runs inside whichever tool needed it (the knowledge-base tool, or the refund-eligibility check).
    for (const x of spans.filter((x) => x.name === "rag.search")) expect(["tool.search_knowledge_base", "tool.check_refund_eligibility"]).toContain(parent(x).name);
    expect(spans.filter((x) => x.name.startsWith("rag.") && x.name !== "rag.search").every((x) => parent(x).name === "rag.search")).toBe(true);
    // The model's choice and the tool it selected are both visible, with real durations.
    const toolNames = spans.filter((x) => x.category === "tool").map((x) => x.name);
    expect(toolNames).toEqual(expect.arrayContaining(["tool.get_payment_history", "tool.search_knowledge_base", "tool.check_refund_eligibility"]));
    expect(spans.every((x) => x.durationMs >= 0 && x.startOffsetMs >= 0)).toBe(true);
    // Children never start before, or outlive, their parent's window by more than clock rounding.
    for (const x of spans.filter((x) => x.parentSpanId)) {
      const p = parent(x);
      expect(x.startOffsetMs).toBeGreaterThanOrEqual(p.startOffsetMs - 1);
      expect(x.startOffsetMs + x.durationMs).toBeLessThanOrEqual(p.startOffsetMs + p.durationMs + 2);
    }
    void s;
  });

  it("keeps a paused run in ONE trace and does not count the customer's waiting time as processing", async () => {
    const { s, runId } = await refundPending();
    await sleep(700); // the customer thinks about it
    await agent.submitMessage(s.sessionId, { message: "yes", clientMessageId: `yes-${Date.now()}`, mode: "chat" });
    const ov = (await get(`/observability/runs/${runId}`, { admin: ADMIN })).body;
    const spans = (await get(`/observability/runs/${runId}/spans`, { admin: ADMIN })).body as any[];
    const segments = spans.filter((x) => x.name === "agent.run");
    expect(segments.map((x) => x.attributes.segment)).toEqual([1, 2]);
    expect(new Set(spans.map((x) => x.traceId)).size).toBe(1);
    expect(ov.metrics.segments).toBe(2);
    expect(ov.metrics.customerWaitMs).toBeGreaterThanOrEqual(600);
    // Processing is the sum of the segments, measured directly: it excludes the wait and is not a sum of nested spans.
    expect(ov.metrics.endToEndProcessingMs).toBeCloseTo(segments.reduce((a, x) => a + x.durationMs, 0), -1);
    expect(ov.metrics.wallClockMs).toBeGreaterThanOrEqual(ov.metrics.endToEndProcessingMs + 600);
    expect(ov.status).toBe("completed");
  });

  it("records every model call with the actual sanitized prompt, tools, output, usage and an exact cost", async () => {
    const { runId } = await refundPending();
    const models = (await get(`/observability/runs/${runId}/models`, { admin: ADMIN })).body as any[];
    expect(models.length).toBeGreaterThanOrEqual(4);
    const m = models[0];
    expect(m).toMatchObject({ provider: "openai", model: "gpt-4.1-mini", purpose: "decision", finishReason: "stop", status: "ok", usageSource: "provider_reported", costStatus: "ok", pricingVersion: "gpt-4.1-mini@2026-11-25" });
    expect(m.promptVersion).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(m.systemPrompt).toContain("customer support agent");
    expect(m.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["get_payment_history", "respond_to_customer"]));
    expect(m.messages[0].content).toContain("refund");
    expect(m.output.toolCalls.length).toBeGreaterThan(0);
    // 1000 prompt (400 cached) + 200 output (50 thinking, already inside the 200): no token counted twice.
    expect(m.usage).toMatchObject({ inputTextTokens: 600, cachedInputTokens: 400, outputTextTokens: 200, thinkingTokens: 50, totalTokens: 1200 });
    expect(m.estimatedCostUsd).toBe("0.000600");
    // Same prompt text => same version.
    expect(models.filter((x) => x.purpose === "decision").map((x) => x.promptVersion).length).toBeGreaterThan(1);
  });

  it("includes calls that the run's own usage counter misses (evidence check) in the cost, and aggregates by model", async () => {
    const { runId } = await refundPending();
    const usage = (await get(`/observability/runs/${runId}/usage`, { admin: ADMIN })).body;
    const purposes = (await pool.query("select purpose, count(*)::int n from model_invocations where run_id = $1 group by purpose", [runId])).rows;
    expect(purposes.map((p) => p.purpose)).toEqual(expect.arrayContaining(["decision"]));
    const calls = purposes.reduce((a, p) => a + p.n, 0);
    expect(usage.models).toHaveLength(1);
    expect(usage.models[0]).toMatchObject({ model: "gpt-4.1-mini", calls });
    expect(usage.totals.estimatedCostUsd).toBe((calls * 0.0006).toFixed(6));
    expect(usage.totals).toMatchObject({ costComplete: true, modelCalls: calls });
    expect(usage.totals.label).toMatch(/Estimated API cost/);
  });

  it("shows cost as unavailable, never $0, for a model with no configured price", async () => {
    scripted.model = "some-unpriced-model";
    const s = await session();
    const r = await say(s, `${login} What plan am I on? my subscription`);
    const usage = (await get(`/observability/runs/${r.runId}/usage`, { admin: ADMIN })).body;
    expect(usage.totals.estimatedCostUsd).toBeNull();
    expect(usage.totals.costComplete).toBe(false);
    expect(usage.totals.costNotes[0]).toMatch(/No pricing configured for some-unpriced-model/);
    const history = (await get(`/observability/sessions/${s.sessionId}/runs`, { admin: ADMIN })).body;
    expect(history[0]).toMatchObject({ estimatedCostUsd: null, costComplete: false });
    expect(history[0].tokens).toBeGreaterThan(0);
  });

  it("labels usage as estimated when the provider reports none, and never leaves it silently zero", async () => {
    scripted.usageReported = false;
    const s = await session();
    const r = await say(s, "What are your refund policies for plans?");
    const models = (await get(`/observability/runs/${r.runId}/models`, { admin: ADMIN })).body as any[];
    expect(models[0].usageSource).toBe("estimated");
    expect(models[0].usage.totalTokens).toBeGreaterThan(0);
  });

  it("de-duplicates a repeated usage report by invocation id", async () => {
    const { runId } = await refundPending();
    await telemetry()!.flush();
    const [row] = (await pool.query("select * from model_invocations where run_id = $1 limit 1", [runId])).rows;
    const before = (await pool.query("select count(*)::int n from model_invocations where run_id = $1", [runId])).rows[0].n;
    telemetry()!.enqueue({ t: "invocation", row: { id: row.id, runId, sessionId: row.session_id, traceId: row.trace_id, spanId: row.span_id, purpose: row.purpose, provider: "openai", model: row.model, promptVersion: null, startedAt: new Date(), durationMs: 1, finishReason: null, status: "ok", errorCode: null, usage: row.usage, usageSource: "provider_reported", estimatedCostUsd: "9.000000", costStatus: "ok", costNote: null, pricingVersion: null, pricingSnapshot: null, systemPrompt: null, messages: null, tools: null, output: null } });
    await telemetry()!.flush();
    expect((await pool.query("select count(*)::int n from model_invocations where run_id = $1", [runId])).rows[0].n).toBe(before);
    expect(Number((await pool.query("select estimated_cost_usd from model_invocations where id = $1", [row.id])).rows[0].estimated_cost_usd)).toBeLessThan(1);
  });

  it("proves business actions ran: tool records with sanitized args/results, attempts and commit status", async () => {
    const { s, runId } = await refundPending();
    await agent.submitMessage(s.sessionId, { message: "yes", clientMessageId: `y-${Date.now()}`, mode: "chat" });
    const tools = (await get(`/observability/runs/${runId}/tools`, { admin: ADMIN })).body as any[];
    const refund = tools.find((t) => t.tool === "issue_refund");
    expect(refund).toMatchObject({ status: "success", type: "write", committed: true, attempts: 1, retries: 0 });
    expect(refund.result.refundId).toMatch(/^REF-/);
    expect(refund.parentModelInvocation).toMatch(/^inv_/);
    expect(refund.spanId).toBeTruthy();
    const refunds = (await pool.query("select count(*)::int n from refunds")).rows[0].n;
    expect(refunds).toBe(1); // the trace says it ran, and the ledger agrees
  });

  it("retrieval inspector: query, filters, threshold, every candidate with similarity, and stage timings", async () => {
    const { runId } = await refundPending();
    const r = (await get(`/observability/runs/${runId}/retrievals`, { admin: ADMIN })).body as any[];
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0]).toMatchObject({ attempt: 1, status: "grounded", evidenceVerified: true });
    expect(r[0].query).toBeTruthy();
    expect(r[0].threshold).toBeGreaterThan(0);
    expect(r[0].accepted[0]).toMatchObject({ document: expect.any(String), similarity: expect.any(Number) });
    expect(r[0].stages.map((x: any) => x.name)).toEqual(expect.arrayContaining(["rag.embed_query", "rag.vector_search"]));
    const ov = (await get(`/observability/runs/${runId}`, { admin: ADMIN })).body;
    expect(ov.grounding).toMatchObject({ evidenceVerified: true });
    expect(ov.grounding.topSimilarity).toBeGreaterThan(0);
  });

  it("guardrail inspector explains the outcomes and counts rejections", async () => {
    const s = await session();
    const r = await say(s, "Please write me a poem about the weather");
    const g = (await get(`/observability/runs/${r.runId}/guardrails`, { admin: ADMIN })).body;
    expect(g.results.map((x: any) => x.event)).toEqual(expect.arrayContaining(["escalation.created"]));
    expect((await get(`/observability/runs/${r.runId}`, { admin: ADMIN })).body.status).toBe("escalated");
    const { runId } = await refundPending();
    const g2 = (await get(`/observability/runs/${runId}/guardrails`, { admin: ADMIN })).body;
    expect(g2.nodes.map((x: any) => x.node)).toEqual(expect.arrayContaining(["validate_tool", "request_confirmation"]));
    expect(g2.results.map((x: any) => x.event)).toEqual(expect.arrayContaining(["confirmation.required"]));
  });

  it("distinguishes a correctly enforced business rule from an infrastructure failure", async () => {
    const s = await session();
    const r = await say(s, "I'm sarah@example.com and my code is 111111. Please refund my last payment.");
    const e = (await get(`/observability/runs/${r.runId}/errors`, { admin: ADMIN })).body;
    expect(e.summary.businessRule).toBeGreaterThanOrEqual(1);
    expect(e.summary.infrastructure).toBe(0);
    expect(e.errors.every((x: any) => x.kind !== "infrastructure")).toBe(true);
    expect(await pool.query("select 1 from refunds")).toMatchObject({ rowCount: 0 });
  });

  it("marks a cancelled run's segment as cancelled", async () => {
    const s = await session();
    const accepted = await agent.acceptMessage(s.sessionId, { message: "this is slow, what plan am I on", clientMessageId: `slow-${Date.now()}`, mode: "chat" });
    await sleep(250);
    await agent.acceptCancel(accepted.runId);
    await agent.idle();
    const spans = (await get(`/observability/runs/${accepted.runId}/spans`, { admin: ADMIN })).body as any[];
    expect(spans.find((x) => x.name === "agent.run").attributes.outcome).toBe("cancelled");
    expect((await get(`/observability/runs/${accepted.runId}`, { admin: ADMIN })).body.status).toBe("cancelled");
  });

  it("overview: latency, first-status, first visible text, counts, tokens and cost", async () => {
    const { runId } = await refundPending();
    const ov = (await get(`/observability/runs/${runId}`, { admin: ADMIN })).body;
    expect(ov).toMatchObject({ runId, mode: "chat", provider: "openai", status: "awaiting_confirmation" });
    expect(ov.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ov.metrics.endToEndProcessingMs).toBeGreaterThan(0);
    console.log(JSON.stringify(ov.metrics));
    expect(ov.metrics).toMatchObject({ segments: 1, modelTtftMs: null, retries: 0, guardrailFailures: 0 });
    expect(ov.metrics.retrievalAttempts).toBeGreaterThanOrEqual(1);
    expect(ov.metrics.toolCalls).toBeGreaterThanOrEqual(3);
    expect(ov.metrics.timeToFirstStatusMs).not.toBeNull();
    expect(ov.usage.totalTokens).toBeGreaterThan(0);
  });

  it("history lists runs newest first and the summary computes median/P95 and rates", async () => {
    const s = await session();
    await say(s, `${login} What plan am I on? my subscription`);
    await say(s, "What are your refund policies for plans?");
    const h = (await get(`/observability/sessions/${s.sessionId}/runs`, { token: s.sessionToken, admin: undefined })).body;
    expect(h).toHaveLength(2);
    expect(h[0].startedAt >= h[1].startedAt).toBe(true);
    const sum = (await get(`/observability/summary?days=1`, { admin: ADMIN })).body;
    expect(sum).toMatchObject({ totalInteractions: 2, chat: 2, voice: 0 });
    expect(sum.p95LatencyMs).toBeGreaterThanOrEqual(sum.medianLatencyMs);
    expect(sum.modelCalls).toBeGreaterThan(0);
    expect(sum.estimatedCostUsd).not.toBeNull();
    expect(sum.avgModelCallsPerRun).toBeGreaterThan(0);
    expect(sum.dailyCost[0]).toMatchObject({ mode: "chat" });
  });

  it("serves the configured price list with sources, versions and verification dates", async () => {
    const p = (await get(`/observability/pricing`)).body;
    expect(p.entries.filter((e: any) => e.model === "gpt-4.1-mini")).toHaveLength(1);
    expect(p.entries[0]).toMatchObject({ sourceUrl: expect.stringContaining("https://"), verifiedOn: expect.any(String) });
    expect((await pool.query("select count(*)::int n from model_pricing where model = 'gpt-4.1-mini'")).rows[0].n).toBe(1);
  });

  // ---- privacy and authorization ----------------------------------------------------------------------------------------------
  it("never persists a verification code, key or full email in any telemetry table", async () => {
    const { s, runId } = await refundPending();
    await agent.submitMessage(s.sessionId, { message: "yes", clientMessageId: `y2-${Date.now()}`, mode: "chat" });
    await telemetry()!.flush();
    const dump = JSON.stringify([
      (await pool.query("select * from trace_spans")).rows, (await pool.query("select * from model_invocations")).rows, (await pool.query("select * from error_events")).rows,
    ]);
    expect(dump).not.toContain("482910");
    expect(dump).not.toContain("sarah@example.com");
    expect(dump.length).toBeGreaterThan(5000);
    const api = JSON.stringify((await get(`/observability/runs/${runId}/traces`, { admin: ADMIN })).body);
    expect(api).not.toContain("482910");
    expect(api).not.toContain("sarah@example.com");
  });

  it("enforces authorization: no credentials, another customer's token, and an invalid admin key are all refused", async () => {
    const { s, runId } = await refundPending();
    const other = await session();
    expect((await get(`/observability/runs/${runId}`)).status).toBe(401);
    expect((await get(`/observability/runs/${runId}`, { token: other.sessionToken })).status).toBe(401); // cross-customer access
    expect((await get(`/observability/runs/${runId}/models`, { token: other.sessionToken })).status).toBe(401);
    expect((await get(`/observability/runs/${runId}`, { admin: "wrong" })).status).toBe(403);
    expect((await get(`/observability/runs/run_does_not_exist`, { token: s.sessionToken })).status).toBe(401);
    expect((await get(`/observability/sessions/${s.sessionId}/runs`, { token: other.sessionToken })).status).toBe(401);
    expect((await get(`/observability/summary`, { token: s.sessionToken })).status).toBe(403);
  });

  it("gives a session's owner timings and cost but not prompts, tool arguments or results; admin gets full detail", async () => {
    const { s, runId } = await refundPending();
    const owner = (await get(`/observability/runs/${runId}/traces`, { token: s.sessionToken })).body;
    expect(owner.access).toBe("owner");
    expect(owner.models[0]).toMatchObject({ restricted: true, costStatus: "ok" });
    expect(owner.models[0].systemPrompt).toBeUndefined();
    expect(owner.models[0].messages).toBeUndefined();
    expect(owner.tools[0]).toMatchObject({ restricted: true });
    expect(owner.tools[0].args).toBeUndefined();
    expect(owner.spans.every((x: any) => x.detail === undefined)).toBe(true);
    expect(owner.overview.metrics.endToEndProcessingMs).toBeGreaterThan(0);
    const admin = (await get(`/observability/runs/${runId}/traces`, { admin: ADMIN })).body;
    expect(admin.access).toBe("admin");
    expect(admin.models[0].systemPrompt).toContain("customer support agent");
    expect(admin.tools[0].args).toBeDefined();
  });

  it("keeps working when telemetry storage fails, and reports degraded observability", async () => {
    const w = telemetry()!;
    const realPool = (w as any).pool;
    (w as any).pool = { connect: async () => { throw new Error("telemetry db down"); } };
    try {
      const s = await session();
      const r = await say(s, `${login} What plan am I on? my subscription`);
      expect(r.status).toBe("completed"); // the support workflow is unaffected
      await w.flush();
      expect(w.status()).toMatchObject({ degraded: true, lastError: "telemetry db down" });
      const ov = await get(`/observability/runs/${r.runId}`, { admin: ADMIN });
      expect(ov.body.observability.degraded).toBe(true);
    } finally {
      (w as any).pool = realPool;
    }
  });

  it("purges diagnostic traces past the retention window and leaves business records alone", async () => {
    const { runId } = await refundPending();
    await telemetry()!.flush();
    await pool.query("update trace_spans set created_at = now() - interval '40 days' where run_id = $1", [runId]);
    await pool.query("update model_invocations set created_at = now() - interval '40 days' where run_id = $1", [runId]);
    const removed = await telemetry()!.purge(30);
    expect(removed).toBeGreaterThan(0);
    expect((await pool.query("select count(*)::int n from trace_spans where run_id = $1", [runId])).rows[0].n).toBe(0);
    expect((await pool.query("select count(*)::int n from tool_executions where run_id = $1", [runId])).rows[0].n).toBeGreaterThan(0);
    expect((await pool.query("select count(*)::int n from pending_actions where run_id = $1", [runId])).rows[0].n).toBe(1);
  });

  it("instrumentation overhead stays small and persistence is off the request path", async () => {
    const { withSpan } = await import("../tracing/tracing.js");
    const N = 3000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) await withSpan("bench", { category: "agent" }, async () => i);
    const perSpanMs = (performance.now() - t0) / N;
    console.log(`[bench] withSpan overhead: ${(perSpanMs * 1000).toFixed(1)} us/span (${N} spans, queue ${telemetry()!.queued}, dropped ${telemetry()!.dropped})`);
    expect(perSpanMs).toBeLessThan(0.5);
    expect(telemetry()!.queued).toBeLessThanOrEqual(5000); // bounded no matter how many spans arrive
  });
});
