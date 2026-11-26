import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LlmError } from "../providers/llm-provider.interface.js";
import { UnconfiguredLlmProvider } from "../providers/unconfigured-llm.provider.js";
import { ask, callTool, respond, type ScriptedResponder } from "../providers/scripted-llm.provider.js";
import { buildAgentHarness, codePlaceholder, count, deferred, firstSourceId, pool, refundIdFrom, sleep, type AgentHarness } from "./agent-harness.js";

const SARAH = "sarah@example.com";
const login = "I'm sarah@example.com and my code is 482910.";
const verifyAs = (email = SARAH): ScriptedResponder => (req) => callTool("verify_identity", { email, verificationCode: codePlaceholder(req) });
const ticket = async () => (await pool.query("select * from escalation_tickets order by created_at desc limit 1")).rows[0];
const types = async (runId: string) => (await pool.query("select seq, type, data from trace_events where run_id = $1 order by seq", [runId])).rows as Array<{ seq: number; type: string; data: Record<string, unknown> }>;
const untilRunning = async () => {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query("select id from agent_runs where status = 'running'");
    if (rows[0]) return rows[0].id as string;
    await sleep(20);
  }
  throw new Error("run never started");
};
const refundUntilConfirm: ScriptedResponder[] = [
  verifyAs(),
  () => callTool("get_payment_history", {}),
  () => callTool("search_knowledge_base", { query: "refund policy for a recent payment" }),
  () => callTool("issue_refund", { paymentId: "PAY-002" }),
];
const finishRefund: ScriptedResponder = (req) => respond(`Your refund ${refundIdFrom(req)} of $49 has been processed.`, [firstSourceId(req)]);

describe("agent resilience", () => {
  let h: AgentHarness;
  beforeAll(async () => {
    h = await buildAgentHarness({ timeoutOverrideMs: 2000 });
    await h.ingest();
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.reset();
    h.llm.use([]);
    h.simulator.clear();
  });
  afterEach(() => {
    h.simulator.clear();
    Object.assign(h.deps.cfg, { maxIterations: 12, maxToolCalls: 15, deadlineMs: 60_000 });
  });

  describe("execution limits and loops", () => {
    it("stops at the iteration budget and escalates instead of looping", async () => {
      h.deps.cfg.maxIterations = 4;
      h.llm.use([verifyAs(), (_req, i) => callTool("get_payment_history", { limit: i })]); // always something "new", never finishes
      const r = await (await h.session()).say(`Keep checking my payments. ${login}`);
      expect(h.llm.decisionRequests.length).toBeLessThanOrEqual(4);
      expect(r.status).toBe("escalated");
      expect((await ticket()).summary).toContain("MAX_ITERATIONS");
    });

    it("stops at the tool-call budget", async () => {
      h.deps.cfg.maxToolCalls = 3;
      h.llm.use([verifyAs(), (_req, i) => callTool("get_payment_history", { limit: i })]);
      const r = await (await h.session()).say(`Keep checking my payments. ${login}`);
      expect(r.status).toBe("escalated");
      expect(await count("tool_executions", "tool = 'get_payment_history'")).toBeLessThanOrEqual(3);
      expect((await ticket()).summary).toContain("MAX_TOOL_CALLS");
    });

    it("blocks an identical repeated tool call and halts a model that will not stop", async () => {
      h.llm.use([verifyAs(), () => callTool("get_subscription", {})]); // the same call forever
      const r = await (await h.session()).say(`What plan am I on? ${login}`);
      expect(r.status).toBe("escalated");
      expect(await count("tool_executions", "tool = 'get_subscription'")).toBe(1); // executed once, then blocked
      expect(h.llm.decisionRequests.length).toBeLessThan(8);
      expect((await ticket()).summary).toContain("REPEATED_CALLS");
    });

    it("allows repeating a tool after the world changed (identity verified in between)", async () => {
      h.llm.use([
        () => callTool("get_subscription", {}), // fails: not verified
        verifyAs(),
        () => callTool("get_subscription", {}), // same call, new epoch: legitimate
        () => respond("You're on the Pro plan, billed monthly at $49."),
      ]);
      const r = await (await h.session()).say(login);
      expect(r.status).toBe("completed");
      expect(await count("tool_executions", "tool = 'get_subscription'")).toBe(2);
    });

    it("halts after repeated tool failures", async () => {
      h.llm.use([verifyAs(), (_req, i) => callTool("get_subscription", { customerId: `CUST-9${i}` })]); // different args, same failure
      const r = await (await h.session()).say(`Show me accounts. ${login}`);
      expect(r.status).toBe("escalated");
      expect((await ticket()).summary).toMatch(/failure streak; ACCESS_DENIED/);
    });

    it("enforces the active-time deadline", async () => {
      h.deps.cfg.deadlineMs = 150;
      h.llm.use([async () => (await sleep(300), callTool("get_payment_history", {}))]);
      const r = await (await h.session()).say("hello");
      expect(r.status).toBe("escalated");
      expect((await ticket()).summary).toContain("DEADLINE_EXCEEDED");
    });
  });

  describe("model and tool failures", () => {
    it("falls back gracefully when the model times out: honest message, real ticket", async () => {
      h.llm.use([() => ({ throws: new LlmError("LLM_TIMEOUT", "slow", true) })]);
      const s = await h.session();
      const r = await s.say("hello");
      expect(r.status).toBe("escalated");
      expect(r.response).toContain(r.escalationTicketId!);
      expect((await ticket()).summary).toContain("LLM_TIMEOUT");
      expect(await count("llm_calls", "error_code = 'LLM_TIMEOUT'")).toBe(1);
    });

    it("handles a rate-limited model the same way", async () => {
      h.llm.use([() => ({ throws: new LlmError("LLM_RATE_LIMIT", "429", true) })]);
      const r = await (await h.session()).say("hello");
      expect(r.status).toBe("escalated");
      expect((await ticket()).summary).toContain("LLM_RATE_LIMIT");
    });

    it("works without an API key: the agent degrades to escalation instead of failing", async () => {
      const bare = await buildAgentHarness({ llm: new UnconfiguredLlmProvider("none") });
      try {
        const r = await (await bare.session()).say("I need help with my invoice");
        expect(r.status).toBe("escalated");
        expect(r.response).toContain(r.escalationTicketId!);
        expect((await ticket()).summary).toContain("LLM_NOT_CONFIGURED");
      } finally {
        await bare.close();
      }
    });

    it("retries a transient tool failure invisibly and reports a permanent one to the model", async () => {
      h.simulator.arm("get_payment_history", "db_temporary", 1);
      h.simulator.arm("get_subscription", "permanent");
      h.llm.use([
        verifyAs(),
        () => callTool("get_payment_history", {}),
        () => callTool("get_subscription", {}),
        () => ask("I couldn't load your subscription right now. Would you like me to pass this to a human?"),
      ]);
      const r = await (await h.session()).say(`Show my account. ${login}`);
      const rows = (await pool.query("select tool, status, attempts, error_code from tool_executions where run_id = $1 order by created_at", [r.runId])).rows;
      expect(rows.find((x) => x.tool === "get_payment_history")).toMatchObject({ status: "success", attempts: 2 });
      expect(rows.find((x) => x.tool === "get_subscription")).toMatchObject({ status: "failed", error_code: "SIMULATED_FAILURE", attempts: 1 });
      expect(r.status).toBe("awaiting_input");
    });

    it("stops sensitive work and reports honestly when the database is unavailable", async () => {
      h.simulator.arm("get_payment_history", "db_temporary", 99);
      h.llm.use([verifyAs(), () => callTool("get_payment_history", {}), () => respond("should never be asked again")]);
      const r = await (await h.session()).say(`Show my payments. ${login}`);
      expect(r.status).toBe("escalated"); // the ticket could still be written, so it is reported
      expect(h.llm.decisionRequests).toHaveLength(2); // no more decisions or tools after the outage was detected
      expect((await ticket()).summary).toContain("DATABASE_UNAVAILABLE");
    });

    it("never claims a ticket exists when the ticket could not be created", async () => {
      h.simulator.arm("create_escalation_ticket", "permanent");
      h.llm.use([() => ({ throws: new LlmError("LLM_UNAVAILABLE", "down", true) })]);
      const r = await (await h.session()).say("hello");
      expect(r.status).toBe("failed");
      expect(r.response).toContain("wasn't able to create a support ticket");
      expect(r.response).not.toMatch(/TKT-\d+/);
      expect(await count("escalation_tickets")).toBe(0);
      expect((await pool.query("select status, error_code from agent_runs where id = $1", [r.runId])).rows[0]).toMatchObject({ status: "failed" });
    });
  });

  describe("concurrency, restart and cancellation", () => {
    it("allows only one active run per session and answers the second message with 409", async () => {
      const gate = deferred();
      h.llm.use([async () => (await gate.promise, respond("Hello!"))]);
      const s = await h.session();
      const first = s.say("hi", "m1");
      await untilRunning();
      await expect(s.say("hello again", "m2")).rejects.toThrow(/already executing/);
      gate.resolve();
      expect((await first).status).toBe("completed");
      expect(await count("messages", "role = 'user'")).toBe(1); // the rejected message was not recorded
      h.llm.use([() => respond("Hello again!")]);
      expect((await s.say("hello again", "m3")).status).toBe("completed"); // the session is free again
    });

    it("lets different sessions run in parallel", async () => {
      h.llm.use([() => respond("Hello!")]);
      const [a, b] = await Promise.all([h.session(), h.session()]);
      const results = await Promise.all([a.say("hi"), b.say("hi")]);
      expect(results.map((r) => r.status)).toEqual(["completed", "completed"]);
    });

    it("recovers a paused refund after a full restart (new process state, same database)", async () => {
      h.llm.use(refundUntilConfirm);
      const s = await h.session();
      const first = await s.say(`Refund my last payment. ${login}`);
      expect(first.status).toBe("awaiting_confirmation");

      // simulate a restart: brand-new service graph, checkpointer connection and in-memory registries
      const restarted = await buildAgentHarness({ script: [finishRefund] });
      try {
        const second = await restarted.agent.submitMessage(s.sessionId, { message: "yes", clientMessageId: "after-restart", mode: "chat" });
        expect(second.status).toBe("completed");
        expect(second.runId).toBe(first.runId);
        expect(second.response).toContain("REF-001");
        expect(await count("refunds")).toBe(1);
      } finally {
        await restarted.close();
      }
    });

    it("starts a fresh graph thread when an old one was left paused by a crash", async () => {
      h.llm.use(refundUntilConfirm);
      const s = await h.session();
      const first = await s.say(`Refund my last payment. ${login}`);
      // the crash: the DB no longer considers the run waiting, but the checkpoint still holds the interrupt
      await pool.query("update agent_runs set status = 'failed' where id = $1", [first.runId]);
      h.llm.use([() => respond("Hello again!")]);
      const next = await s.say("hi");
      expect(next.status).toBe("completed");
      expect((await pool.query("select thread_gen from sessions where id = $1", [s.sessionId])).rows[0].thread_gen).toBe(1);
    });

    it("cancels a running turn at the next safe point and says so", async () => {
      const gate = deferred();
      h.llm.use([async () => (await gate.promise, callTool("get_payment_history", {}))]);
      const s = await h.session();
      const running = s.say("hi", "c1");
      const runId = await untilRunning();
      expect(await h.agent.cancelRun(runId)).toEqual({ cancelRequested: true });
      gate.resolve();
      const r = await running;
      expect(r.status).toBe("cancelled");
      expect(r.response).toContain("stopped");
      expect(await count("tool_executions")).toBe(0); // it did not go on to run the tool it had picked
      expect((await types(runId)).map((e) => e.type)).toContain("run.cancelled");
    });

    it("honours a cancel that exists only in the database (never lost to registration timing)", async () => {
      // Regression: a cancel arriving before the run was registered in memory used to be dropped.
      const { createDecisionNode } = await import("../nodes/decision.node.js");
      const s = await h.session();
      const run = await h.runs.start(s.sessionId, "chat", "reg-1");
      await h.runs.requestCancel(run.id); // no registry entry exists for this run
      const out = await createDecisionNode(h.deps)({ sessionId: s.sessionId, runId: run.id, iterationCount: 0, toolCallCount: 0, startedAtMs: 0, messages: [] } as never);
      expect(out.halt).toBe("cancelled");
      expect(h.llm.allRequests).toHaveLength(0); // the model was never called
    });

    it("cancels a run that is waiting for confirmation and leaves nothing to confirm later", async () => {
      h.llm.use(refundUntilConfirm);
      const s = await h.session();
      const first = await s.say(`Refund my last payment. ${login}`);
      const cancelled = await h.agent.cancelRun(first.runId);
      expect(cancelled).toMatchObject({ status: "cancelled" });
      expect(await count("refunds")).toBe(0);
      expect(await count("pending_actions", "status = 'superseded'")).toBe(1);
      h.llm.use([() => respond("Hi!")]);
      expect((await s.say("yes")).status).toBe("completed"); // a later 'yes' confirms nothing: it is just a new message
      expect(await count("refunds")).toBe(0);
    });

    it("frees sessions blocked by a run that was left 'running' by a crash", async () => {
      const s = await h.session();
      await pool.query("insert into agent_runs (id, session_id, status, mode, started_at) values ('run_stale', $1, 'running', 'chat', now() - interval '1 hour')", [s.sessionId]);
      expect(await h.runs.reapStale(60_000)).toBe(1);
      expect((await pool.query("select status, error_code from agent_runs where id = 'run_stale'")).rows[0]).toEqual({ status: "failed", error_code: "STALE_RUN" });
    });
  });

  describe("events, usage and traces", () => {
    it("publishes ordered lifecycle events across a pause and resume", async () => {
      h.llm.use([...refundUntilConfirm, finishRefund]);
      const s = await h.session();
      const live: string[] = [];
      const sub = h.events.events$.subscribe((e) => e.sessionId === s.sessionId && live.push(e.type));
      const first = await s.say(`Refund my last payment. ${login}`);
      await s.say("yes");
      sub.unsubscribe();

      const rows = await types(first.runId);
      const seqs = rows.map((r) => r.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length); // strictly increasing, no duplicates across the pause
      const t = rows.map((r) => r.type);
      for (const expected of ["run.started", "context.loaded", "decision.completed", "tool.started", "tool.completed", "retrieval.completed", "guardrail.passed", "confirmation.required", "run.paused", "response.delta", "response.completed", "usage.updated", "run.completed"]) {
        expect(t, expected).toContain(expected);
      }
      expect(t.filter((x) => x === "run.started")).toHaveLength(2); // initial + resumed
      expect(t.filter((x) => x === "confirmation.required")).toHaveLength(1); // not repeated when the node re-runs on resume
      expect(t.indexOf("run.paused")).toBeLessThan(t.lastIndexOf("run.started"));
      expect(live).toEqual(t); // the live stream and the persisted record agree
      const text = rows.filter((r) => r.type === "response.delta").map((r) => r.data.text).join("");
      expect(text).toBe(rows.find((r) => r.type === "response.completed")!.data.text);
    });

    it("records usage, cost, model calls and retrieval evidence for every run", async () => {
      h.llm.use([...refundUntilConfirm, finishRefund]);
      const s = await h.session();
      const first = await s.say(`Refund my last payment. ${login}`);
      const done = await s.say("yes");
      const usage = (await pool.query("select * from usage_metrics where run_id = $1", [first.runId])).rows[0];
      expect(usage).toMatchObject({ model: "scripted-1", llm_calls: 5, input_tokens: 500, output_tokens: 100 });
      expect(Number(usage.est_cost_usd)).toBeGreaterThan(0);
      expect(done.metrics).toMatchObject({ llmCalls: 5, inputTokens: 500, outputTokens: 100 });
      expect(await count("llm_calls", "run_id = $1", [first.runId])).toBe(5);
      const retrieval = await pool.query("select * from retrieval_results where run_id = $1", [first.runId]);
      expect(retrieval.rows.length).toBeGreaterThan(0);
      expect(retrieval.rows[0]).toMatchObject({ document: "refund-policy.md", evidence_verified: true });
    });

    it("stores no prompt text by default, and the trace view is sanitized", async () => {
      h.llm.use([...refundUntilConfirm, finishRefund]);
      const s = await h.session();
      const first = await s.say(`Refund my last payment. ${login}`);
      expect(await count("llm_calls", "prompt is not null")).toBe(0);
      const traces = await h.trace.tracesForRun(first.runId);
      expect(JSON.stringify(traces)).not.toContain("482910");
      expect(traces).toMatchObject({ events: expect.any(Array), llmCalls: expect.any(Array), retrieval: expect.any(Array), toolExecutions: expect.any(Array) });
    });

    it("summarizes long conversations so the prompt window stays bounded", async () => {
      h.deps.cfg.historyWindow = 4;
      try {
        h.llm.use([() => ask("Anything else?")]);
        h.llm.auxiliary.summary = () => ({ content: "Customer asked several general questions; no actions taken." });
        const s = await h.session();
        for (let i = 0; i < 6; i++) await s.say(`question ${i}`);
        for (let i = 0; i < 40 && !(await pool.query("select conversation_summary from sessions where id = $1", [s.sessionId])).rows[0].conversation_summary; i++) await sleep(25);
        expect((await pool.query("select conversation_summary from sessions where id = $1", [s.sessionId])).rows[0].conversation_summary).toContain("general questions");
        await s.say("one more");
        const last = h.llm.decisionRequests.at(-1)!;
        expect(last.system).toContain("Summary of earlier conversation");
        expect(last.messages.filter((m) => m.role === "user" || m.role === "assistant").length).toBeLessThanOrEqual(4);
      } finally {
        h.deps.cfg.historyWindow = 20;
      }
    });
  });

  describe("session ownership", () => {
    it("only the holder of the session token can use the session", async () => {
      const { sessionId, sessionToken } = await h.agent.createSession();
      expect(await h.sessions.authenticate(sessionId, sessionToken)).toMatchObject({ id: sessionId });
      expect(await h.sessions.authenticate(sessionId, "wrong")).toBeNull();
      expect(await h.sessions.authenticate(sessionId, undefined)).toBeNull();
      const other = await h.agent.createSession();
      expect(await h.sessions.authenticate(sessionId, other.sessionToken)).toBeNull();
      await pool.query("update sessions set expires_at = now() - interval '1 second' where id = $1", [sessionId]);
      expect(await h.sessions.authenticate(sessionId, sessionToken)).toBeNull();
    });
  });
});
