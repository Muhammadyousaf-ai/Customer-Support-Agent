import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AgentService } from "../../agent/agent.service.js";
import { configureApp } from "../../app.setup.js";
import { BudgetService } from "../../budget/budget.service.js";
import { pool } from "../../database/pool.js";
import { seedDatabase } from "../../database/seed-data.js";
import { lifecycle } from "../../lifecycle/lifecycle-state.js";
import { IngestionService } from "../../rag/ingestion/ingestion.service.js";

Object.assign(process.env, {
  AGENT_LLM: "e2e", E2E_LLM_DELAY_MS: "200", EMBEDDINGS_PROVIDER: "local", OPENAI_API_KEY: "", VOICE_PROVIDER: "fake",
  RATE_LIMIT_SESSION_PER_MIN: "5", RATE_LIMIT_IP_PER_MIN: "1000", ADMIN_API_KEY: "test-admin-key-0123456789", DAILY_AI_BUDGET_USD: "100", BUDGET_RUN_RESERVE_USD: "0.4", BUDGET_UNPRICED_CALL_USD: "0.01", MAX_BODY_BYTES: "2048",
});
const { AppModule } = await import("../../app.module.js");
const ADMIN = "test-admin-key-0123456789";
const login = "I'm sarah@example.com, my code is 482910.";

describe("production hardening (real HTTP + PostgreSQL)", () => {
  let app: INestApplication;
  let base: string;
  let origin: string;
  let agent: AgentService;
  let budget: BudgetService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app, "http://localhost:3000", { maxBodyBytes: 2048 });
    await app.init();
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    origin = `http://127.0.0.1:${port}`;
    base = `${origin}/v1`;
    agent = app.get(AgentService);
    budget = app.get(BudgetService);
    await app.get(IngestionService).ingestDirectory();
  });
  afterAll(async () => {
    lifecycle.draining = false;
    await agent.idle();
    await app.close();
  });
  beforeEach(async () => {
    lifecycle.draining = false;
    await agent.idle();
    await seedDatabase(pool);
    (budget as any).held.clear(); // reservations are per process; each test starts with none
    (budget as any).env.DAILY_AI_BUDGET_USD = 100;
  });

  const call = async (path: string, init: RequestInit & { token?: string; admin?: string } = {}) => {
    const { token, admin, ...rest } = init;
    const res = await fetch(`${base}${path}`, { ...rest, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(admin ? { "x-admin-key": admin } : {}), ...(rest.headers ?? {}) } });
    return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as any };
  };
  const session = async () => (await call("/sessions", { method: "POST" })).body as { sessionId: string; sessionToken: string };
  let n = 0;
  const send = (s: { sessionId: string; sessionToken: string }, message: string) => call(`/sessions/${s.sessionId}/messages`, { method: "POST", token: s.sessionToken, body: JSON.stringify({ message, clientMessageId: `h${++n}-${Date.now()}` }) });

  // ---- headers, input limits, CORS ------------------------------------------------------------------------------------
  it("sends security headers and no framework banner", async () => {
    const r = await call("/health/live");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(r.headers.get("x-frame-options")).toBeTruthy();
    expect(r.headers.get("x-powered-by")).toBeNull();
    expect(r.headers.get("strict-transport-security")).toBeTruthy();
  });
  it("rejects an oversized body and malformed input with 4xx, never 5xx", async () => {
    const s = await session();
    expect((await call(`/sessions/${s.sessionId}/messages`, { method: "POST", token: s.sessionToken, body: JSON.stringify({ message: "x".repeat(5000), clientMessageId: "big" }) })).status).toBe(413);
    expect((await send(s, "")).status).toBe(400);
    expect((await call(`/sessions/${s.sessionId}/messages`, { method: "POST", token: s.sessionToken, body: "{not json" })).status).toBe(400);
    expect((await call(`/sessions/${s.sessionId}/messages`, { method: "POST", token: s.sessionToken, body: JSON.stringify({ message: 7, clientMessageId: 1 }) })).status).toBe(400);
    expect((await call(`/sessions/${s.sessionId}'; drop table sessions;--`, { token: s.sessionToken })).status).toBe(401); // ids are parameters, never SQL
    expect((await pool.query("select to_regclass('sessions') as t")).rows[0].t).toBe("sessions");
  });
  it("only allows the configured origin through CORS", async () => {
    const ok = await fetch(`${base}/health/live`, { headers: { origin: "http://localhost:3000" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const bad = await fetch(`${base}/health/live`, { headers: { origin: "https://evil.example" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  // ---- session ownership on every endpoint ------------------------------------------------------------------------------
  it("refuses every session/run/voice/trace endpoint to another conversation's token, and to no token", async () => {
    const a = await session();
    const b = await session();
    const sent = await send(a, `${login} Please refund my last payment.`);
    expect(sent.status).toBe(202);
    await agent.idle();
    const runId = sent.body.runId as string;
    const voice = await call(`/sessions/${a.sessionId}/voice`, { method: "POST", token: a.sessionToken, body: "{}" });
    const routes: Array<[string, string]> = [
      ["GET", `/sessions/${a.sessionId}`], ["PATCH", `/sessions/${a.sessionId}`], ["GET", `/sessions/${a.sessionId}/messages`], ["GET", `/sessions/${a.sessionId}/runs`], ["GET", `/sessions/${a.sessionId}/events`],
      ["POST", `/sessions/${a.sessionId}/messages`], ["GET", `/runs/${runId}`], ["GET", `/runs/${runId}/events`], ["POST", `/runs/${runId}/resume`], ["POST", `/runs/${runId}/cancel`],
      ["POST", `/sessions/${a.sessionId}/voice`], ["GET", `/sessions/${a.sessionId}/voice`], ["DELETE", `/sessions/${a.sessionId}/voice`],
      ["POST", `/voice/${voice.body.voiceSessionId}/reconnect`], ["GET", `/voice/${voice.body.voiceSessionId}/metrics`], ["GET", `/voice/${voice.body.voiceSessionId}/turns`],
      ["GET", `/observability/sessions/${a.sessionId}/runs`], ["GET", `/observability/runs/${runId}`], ["GET", `/observability/runs/${runId}/models`], ["GET", `/observability/runs/${runId}/traces`],
    ];
    for (const [method, path] of routes) {
      const body = method === "GET" || method === "DELETE" ? undefined : "{}";
      expect((await call(path, { method, ...(body ? { body } : {}) })).status, `${method} ${path} without a token`).toBe(401);
      expect((await call(path, { method, token: b.sessionToken, ...(body ? { body } : {}) })).status, `${method} ${path} with another token`).toBe(401);
    }
    // The owner, by contrast, is let in.
    expect((await call(`/sessions/${a.sessionId}`, { token: a.sessionToken })).status).toBe(200);
  });
  it("keeps admin-only endpoints closed to session tokens", async () => {
    const s = await session();
    expect((await call("/health/dependencies", { token: s.sessionToken })).status).toBe(403);
    expect((await call("/health/dependencies", { admin: "wrong" })).status).toBe(403);
    const ok = await call("/health/dependencies", { admin: ADMIN });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toMatch(/AIza|sk-|postgres:\/\/|test-admin-key/); // names and state, never secrets
    expect((await call("/observability/summary", { token: s.sessionToken })).status).toBe(403);
  });
  it("rejects a WebSocket from a foreign origin, with no ticket, or with a replayed ticket", async () => {
    const s = await session();
    const created = await call(`/sessions/${s.sessionId}/voice`, { method: "POST", token: s.sessionToken, body: "{}" });
    const open = (ticket: string, o?: string) => new Promise<number>((resolve) => {
      const ws = new WebSocket(`${origin.replace("http", "ws")}/ws/voice`, ["voice.v1", `ticket.${ticket}`], o ? { headers: { origin: o } } : {});
      ws.once("open", () => { ws.close(); resolve(101); });
      ws.once("unexpected-response", (_q, res) => resolve(res.statusCode ?? 0));
      ws.once("error", () => resolve(0));
    });
    expect(await open(created.body.ticket, "https://evil.example")).toBe(403);
    expect(await open("")).toBe(401);
    expect(await open(created.body.ticket)).toBe(101);
    expect(await open(created.body.ticket)).toBe(401);
  });

  // ---- rate limiting and the daily budget ------------------------------------------------------------------------------------
  it("rate-limits chat submissions per conversation with 429 and Retry-After", async () => {
    const s = await session();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await send(s, "hello there")).status);
    expect(codes.slice(0, 1)[0]).toBe(202);
    expect(codes).toContain(429);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(2);
  });
  it("reserves budget before a run, so simultaneous requests cannot overshoot, and pauses AI use when it is used up", async () => {
    (budget as any).env.DAILY_AI_BUDGET_USD = 1;
    // Budget $1, reserve $0.40 per run: two runs fit, the third (concurrent) must be refused even though nothing has been spent yet.
    const sessions = await Promise.all([session(), session(), session(), session()]);
    const results = await Promise.all(sessions.map((s) => send(s, "What are your refund policy details?")));
    const accepted = results.filter((r) => r.status === 202).length;
    const refused = results.filter((r) => r.status === 503);
    expect(accepted).toBe(2);
    expect(refused).toHaveLength(2);
    expect(refused[0]!.body).toMatchObject({ code: "BUDGET_EXHAUSTED", message: expect.stringContaining("daily AI budget") });
    await agent.idle();
    const st = await budget.status();
    expect(st).toMatchObject({ enabled: true, dailyBudgetUsd: 1 });
    expect(st.reservedUsd).toBeGreaterThan(0);
  });
  it("charges real recorded spend (priced or unpriced) against the budget, and voice is refused too", async () => {
    (budget as any).env.DAILY_AI_BUDGET_USD = 1;
    // Recorded usage today: 120 unpriced scripted calls at $0.01 = $1.20 > budget.
    await pool.query(`insert into agent_runs (id, session_id, status, mode) select 'run_b', id, 'completed', 'chat' from (select id from sessions limit 1) s`).catch(() => undefined);
    const s = await session();
    await pool.query(
      `insert into model_invocations (id, session_id, purpose, provider, model, started_at, duration_ms, status, usage, usage_source, cost_status) select 'inv_b'||g, $1, 'decision', 'openai', 'unpriced', now(), 1, 'ok', '{}'::jsonb, 'unavailable', 'unavailable' from generate_series(1,120) g`, [s.sessionId]);
    expect((await budget.status()).exhausted).toBe(true);
    const r = await send(s, "hello");
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("BUDGET_EXHAUSTED");
    expect((await call(`/sessions/${s.sessionId}/voice`, { method: "POST", token: s.sessionToken, body: "{}" })).status).toBe(503);
    // Reading history still works while AI use is paused.
    expect((await call(`/sessions/${s.sessionId}/messages`, { token: s.sessionToken })).status).toBe(200);
  });

  // ---- health, readiness and graceful drain -----------------------------------------------------------------------------------
  it("liveness does no I/O; readiness reports database, vector store and version", async () => {
    expect((await call("/health/live")).body.status).toBe("alive");
    const r = await call("/health/ready");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "healthy", version: expect.any(String), checks: { database: "healthy", vectorStore: "healthy", configuration: "valid", draining: "no" } });
  });
  it("on shutdown: stops being ready, refuses new runs and voice, but lets in-flight runs finish", async () => {
    const a = await session();
    const b = await session();
    const inflight = await send(a, `${login} What plan am I on? my subscription`);
    expect(inflight.status).toBe(202);
    lifecycle.draining = true; // what LifecycleService does at SIGTERM
    const ready = await call("/health/ready");
    expect(ready.status).toBe(503);
    expect(ready.body.checks.draining).toBe("yes");
    expect((await call("/health/live")).status).toBe(200); // still alive: the platform must not kill it mid-drain
    const refused = await send(b, "hello");
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe("RESTARTING");
    expect((await call(`/sessions/${b.sessionId}/voice`, { method: "POST", token: b.sessionToken, body: "{}" })).status).toBe(503);
    await agent.idle(); // the in-flight run completes normally
    const run = (await call(`/runs/${inflight.body.runId}`, { token: a.sessionToken })).body;
    expect(run.status).toBe("completed");
  });
});
