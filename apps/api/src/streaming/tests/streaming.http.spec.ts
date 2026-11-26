import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { SseEnvelope } from "@support-ai/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentService } from "../../agent/agent.service.js";
import { configureApp } from "../../app.setup.js";
import { pool } from "../../database/pool.js";
import { seedDatabase } from "../../database/seed-data.js";
import { RagService } from "../../rag/rag.service.js";
import { IngestionService } from "../../rag/ingestion/ingestion.service.js";

// Must be set before the Nest module compiles (the env provider reads them once).
Object.assign(process.env, { AGENT_LLM: "e2e", E2E_LLM_DELAY_MS: "15", SSE_HEARTBEAT_MS: "120", SSE_MAX_CONNECTIONS_PER_SESSION: "3", RATE_LIMIT_SESSION_PER_MIN: "6", RATE_LIMIT_IP_PER_MIN: "1000", EMBEDDINGS_PROVIDER: "local", OPENAI_API_KEY: "" });
const { AppModule } = await import("../../app.module.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const login = "I'm sarah@example.com, my code is 482910.";

describe("streaming API (real HTTP + SSE)", () => {
  let app: INestApplication;
  let base: string;
  let agent: AgentService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, "http://localhost:3000");
    await app.init();
    await app.listen(0);
    base = `${await app.getUrl()}/v1`.replace("[::1]", "127.0.0.1");
    agent = app.get(AgentService);
    await app.get(IngestionService).ingestDirectory();
    void app.get(RagService);
  });
  afterAll(async () => {
    await agent.idle();
    await app.close();
  });
  beforeEach(async () => {
    await agent.idle();
    await seedDatabase(pool);
  });

  const json = async (path: string, init: RequestInit & { token?: string } = {}) => {
    const { token, ...rest } = init;
    const res = await fetch(`${base}${path}`, { ...rest, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(rest.headers ?? {}) } });
    return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
  };
  const newSession = async () => (await json("/sessions", { method: "POST" })).body as { sessionId: string; sessionToken: string };
  let n = 0;
  const send = (s: { sessionId: string; sessionToken: string }, message: string, clientMessageId = `c${++n}-${Date.now()}`) =>
    json(`/sessions/${s.sessionId}/messages`, { method: "POST", token: s.sessionToken, body: JSON.stringify({ message, clientMessageId }) });

  /** Minimal SSE client over fetch: collects frames and raw text (for heartbeats). */
  async function openSse(s: { sessionId: string; sessionToken: string }, lastEventId?: number) {
    const controller = new AbortController();
    const res = await fetch(`${base}/sessions/${s.sessionId}/events`, { headers: { authorization: `Bearer ${s.sessionToken}`, ...(lastEventId !== undefined ? { "last-event-id": String(lastEventId) } : {}) }, signal: controller.signal });
    const frames: Array<{ id: string; event: string; envelope: SseEnvelope }> = [];
    let raw = "";
    let ended = false;
    void (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          raw += chunk;
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const id = /^id: (.*)$/m.exec(block)?.[1];
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (id && event && data) frames.push({ id, event, envelope: JSON.parse(data) });
          }
        }
      } catch { /* aborted */ }
      ended = true;
    })();
    const waitFor = async (pred: (f: typeof frames) => boolean, ms = 8000) => {
      const t0 = Date.now();
      while (!pred(frames)) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting; saw: ${frames.map((f) => f.event).join(",")}`);
        await sleep(20);
      }
    };
    return { res, frames, get raw() { return raw; }, get ended() { return ended; }, waitFor, close: () => controller.abort() };
  }
  const types = (frames: Array<{ event: string }>) => frames.map((f) => f.event);
  const seqs = (frames: Array<{ envelope: SseEnvelope }>) => frames.map((f) => f.envelope.sequence);

  it("accepts a message with 202 immediately and streams the run's lifecycle events in order", async () => {
    const s = await newSession();
    const sse = await openSse(s);
    const t0 = Date.now();
    const r = await send(s, "What is your refund policy for monthly plans?");
    expect(r.status).toBe(202);
    expect(Date.now() - t0).toBeLessThan(1500); // returned before the run could have finished
    expect(r.body).toMatchObject({ sessionId: s.sessionId, status: "processing", runId: expect.stringMatching(/^run_/), messageId: expect.any(Number) });

    await sse.waitFor((f) => types(f).includes("run.completed"));
    const f = sse.frames;
    expect(types(f)).toEqual(expect.arrayContaining(["run.started", "context.loaded", "decision.completed", "tool.started", "tool.completed", "retrieval.completed", "guardrail.passed", "response.delta", "response.completed", "run.completed"]));
    expect(seqs(f)).toEqual([...seqs(f)].sort((a, b) => a - b));
    expect(new Set(seqs(f)).size).toBe(f.length);
    expect(f.every((x) => x.id === String(x.envelope.sequence))).toBe(true); // SSE id == sequence == resume cursor
    expect(f[0]!.envelope).toMatchObject({ sessionId: s.sessionId, runId: r.body.runId, type: "run.started", eventId: expect.stringContaining(s.sessionId), timestamp: expect.any(String) });
    const completed = f.find((x) => x.event === "response.completed")!.envelope.payload as { text: string; messageId: number };
    expect(completed.messageId).toBeGreaterThan(0);
    expect(f.filter((x) => x.event === "response.delta").map((x) => (x.envelope.payload as { text: string }).text).join("")).toBe(completed.text);
    const res = await sse.res;
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    sse.close();
  });

  it("drives a refund end to end: confirmation card data, explicit confirm, result payload from the backend", async () => {
    const s = await newSession();
    const sse = await openSse(s);
    const accepted = await send(s, `Can I get my money back for my last payment? ${login}`);
    await sse.waitFor((f) => types(f).includes("run.paused"));
    const confirm = sse.frames.find((x) => x.event === "confirmation.required")!.envelope.payload as any;
    expect(confirm).toMatchObject({ type: "refund", amountCents: 4900, currency: "USD", display: { Customer: "CUST-002", "Payment reference": "PAY-002", "Action type": "Simulated refund" } });
    expect(confirm.display.Subscription).toContain("pro");
    expect((await pool.query("select count(*)::int as n from refunds")).rows[0].n).toBe(0);

    const resumed = await json(`/runs/${accepted.body.runId}/resume`, { method: "POST", token: s.sessionToken, body: JSON.stringify({ actionId: confirm.actionId, decision: "confirm" }) });
    expect(resumed.status).toBe(202);
    await sse.waitFor((f) => types(f).includes("run.completed"));
    const refundDone = sse.frames.find((x) => x.event === "tool.completed" && (x.envelope.payload as any).tool === "issue_refund")!.envelope.payload as any;
    expect(refundDone.result).toMatchObject({ refundId: "REF-001", paymentId: "PAY-002", amountCents: 4900, simulated: true });
    expect(JSON.stringify(sse.frames)).not.toContain("482910"); // no verification code on the wire
    expect((await pool.query("select count(*)::int as n from refunds")).rows[0].n).toBe(1);
    sse.close();
  });

  it("declining creates no transaction and still ends cleanly", async () => {
    const s = await newSession();
    const sse = await openSse(s);
    const a = await send(s, `Refund my last payment please. ${login}`);
    await sse.waitFor((f) => types(f).includes("run.paused"));
    const action = (sse.frames.find((x) => x.event === "confirmation.required")!.envelope.payload as any).actionId;
    await json(`/runs/${a.body.runId}/resume`, { method: "POST", token: s.sessionToken, body: JSON.stringify({ actionId: action, decision: "decline" }) });
    await sse.waitFor((f) => types(f).includes("run.completed"));
    expect((await pool.query("select count(*)::int as n from refunds")).rows[0].n).toBe(0);
    sse.close();
  });

  it("escalates an unsupported request and emits the ticket event", async () => {
    const s = await newSession();
    const sse = await openSse(s);
    await send(s, "Can you predict cryptocurrency prices?");
    await sse.waitFor((f) => types(f).includes("run.completed"));
    expect(sse.frames.find((x) => x.event === "escalation.created")!.envelope.payload).toMatchObject({ ticketId: "TKT-001", priority: expect.any(String) });
    sse.close();
  });

  describe("reconnection and replay", () => {
    it("replays only the events after Last-Event-ID, with no gaps or duplicates", async () => {
      const s = await newSession();
      const first = await openSse(s);
      await send(s, "What is your refund policy for monthly plans?");
      await first.waitFor((f) => types(f).includes("run.completed"));
      const all = seqs(first.frames);
      first.close();
      const cursor = all[Math.floor(all.length / 2)]!;

      const again = await openSse(s, cursor);
      await again.waitFor((f) => f.length >= all.filter((x) => x > cursor).length);
      await sleep(150);
      expect(seqs(again.frames)).toEqual(all.filter((x) => x > cursor));
      again.close();
    });

    it("a fresh connection with no cursor replays the latest run so the UI can rebuild its activity", async () => {
      const s = await newSession();
      await send(s, "What is your refund policy for monthly plans?");
      await agent.idle();
      const fresh = await openSse(s);
      await fresh.waitFor((f) => types(f).includes("run.completed"));
      expect(types(fresh.frames)[0]).toBe("run.started");
      fresh.close();
    });

    it("connecting in the middle of a run loses nothing: replay and live events are stitched without gaps", async () => {
      const s = await newSession();
      await send(s, `Refund please. ${login}`); // several tool steps, each delayed
      await sleep(60); // mid-run
      const late = await openSse(s);
      await late.waitFor((f) => types(f).includes("run.paused"));
      const q = seqs(late.frames);
      expect(q[0]).toBe(1);
      expect(q).toEqual(q.map((_, i) => i + 1)); // contiguous 1..N, no duplicates
      late.close();
    });

    it("sends heartbeat comments on an idle stream", async () => {
      const s = await newSession();
      const sse = await openSse(s);
      await sleep(450);
      expect(sse.raw).toMatch(/: ping \d+/);
      expect(sse.raw).toContain("retry: 3000");
      sse.close();
    });

    it("caps connections per session by closing the oldest", async () => {
      const s = await newSession();
      const conns = [];
      for (let i = 0; i < 4; i++) conns.push(await openSse(s));
      for (let i = 0; i < 40 && !conns[0]!.ended; i++) await sleep(25);
      expect(conns[0]!.ended).toBe(true);
      expect(conns[3]!.ended).toBe(false);
      conns.forEach((c) => c.close());
    });
  });

  describe("conversation state, idempotency and limits", () => {
    it("returns the original run for a repeated clientMessageId", async () => {
      const s = await newSession();
      const a = await send(s, "hello", "same-1");
      const b = await send(s, "hello", "same-1");
      expect(b.status).toBe(202);
      expect(b.body).toMatchObject({ runId: a.body.runId, messageId: a.body.messageId, duplicate: true });
      await agent.idle();
      expect((await pool.query("select count(*)::int as n from messages where role = 'user'")).rows[0].n).toBe(1);
    });

    it("restores a paused conversation from the session view (what a page refresh does)", async () => {
      const s = await newSession();
      const sse = await openSse(s);
      await send(s, `Refund my last payment. ${login}`);
      await sse.waitFor((f) => types(f).includes("run.paused"));
      sse.close();
      const view = (await json(`/sessions/${s.sessionId}`, { token: s.sessionToken })).body;
      expect(view).toMatchObject({ id: s.sessionId, identityVerified: true, activeRun: { status: "awaiting_confirmation" }, pendingAction: { type: "refund", amountCents: 4900, display: { "Payment reference": "PAY-002" } } });
      expect(view.title).toContain("Refund my last payment");
      const messages = (await json(`/sessions/${s.sessionId}/messages`, { token: s.sessionToken })).body as Array<{ role: string; content: string }>;
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(JSON.stringify(messages)).not.toContain("482910");
    });

    it("renames a conversation", async () => {
      const s = await newSession();
      const r = await json(`/sessions/${s.sessionId}`, { method: "PATCH", token: s.sessionToken, body: JSON.stringify({ title: "Billing question" }) });
      expect(r.body.title).toBe("Billing question");
      expect((await json(`/sessions/${s.sessionId}`, { method: "PATCH", token: s.sessionToken, body: JSON.stringify({ title: "" }) })).status).toBe(400);
    });

    it("rejects requests without the session's own token", async () => {
      const a = await newSession();
      const b = await newSession();
      expect((await fetch(`${base}/sessions/${a.sessionId}/events`)).status).toBe(401);
      expect((await fetch(`${base}/sessions/${a.sessionId}/events`, { headers: { authorization: `Bearer ${b.sessionToken}` } })).status).toBe(401);
      expect((await json(`/sessions/${a.sessionId}`, { token: b.sessionToken })).status).toBe(401);
      const run = await send(a, "hello");
      expect((await json(`/runs/${run.body.runId}`, { token: b.sessionToken })).status).toBe(401);
      expect((await json(`/runs/${run.body.runId}/cancel`, { method: "POST", token: b.sessionToken })).status).toBe(401);
    });

    it("rate-limits message flooding per conversation with 429", async () => {
      const s = await newSession();
      const codes: number[] = [];
      for (let i = 0; i < 8; i++) codes.push((await send(s, `hi ${i}`)).status);
      expect(codes.slice(0, 6).every((c) => c === 202 || c === 409)).toBe(true);
      expect(codes.slice(6)).toEqual([429, 429]);
    });

    it("rejects overlapping messages with 409 instead of running two agents", async () => {
      const s = await newSession();
      const a = await send(s, "Can you tell me about the slow policy?");
      expect(a.status).toBe(202);
      const b = await send(s, "second message while the first is running");
      expect(b.status).toBe(409);
      await json(`/runs/${a.body.runId}/cancel`, { method: "POST", token: s.sessionToken });
    });
  });

  it("stops a running agent: cancel returns 202 and the stream reports run.cancelled", async () => {
    const s = await newSession();
    const sse = await openSse(s);
    const a = await send(s, "Please explain the slow refund policy"); // the dev model deliberately stalls on 'slow'
    await sse.waitFor((f) => types(f).includes("run.started"));
    await sleep(80);
    const c = await json(`/runs/${a.body.runId}/cancel`, { method: "POST", token: s.sessionToken });
    expect(c.status).toBe(202);
    await sse.waitFor((f) => types(f).includes("run.cancelled"));
    expect((await json(`/runs/${a.body.runId}`, { token: s.sessionToken })).body.status).toBe("cancelled");
    sse.close();
  });
});
