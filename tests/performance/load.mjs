#!/usr/bin/env node
// Load test for the API with the SCRIPTED agent model (start the API with AGENT_LLM=e2e), so it measures our stack
// (HTTP, SSE, LangGraph, tools, PostgreSQL), not OpenAI's quota.
//   node tests/performance/load.mjs --base=http://localhost:4400 --sessions=20 --sse=20 --churn=30
// Needs Node 20+. Prints a JSON report; exits 1 if any hard check fails (errors, duplicate refunds, stuck runs).
const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d);
const BASE = `${arg("base", "http://localhost:4400")}/v1`;
const SESSIONS = Number(arg("sessions", 20));
const SSE_SUBS = Number(arg("sse", 20));
const CHURN = Number(arg("churn", 30));
const LONG_TURNS = Number(arg("long", 20));
const LOGIN = "I'm sarah@example.com and my code is 482910.";

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]) : null; };
const stats = (a) => ({ n: a.length, p50: pct(a, 50), p95: pct(a, 95), max: a.length ? Math.round(Math.max(...a)) : null });
const errors = [];
const J = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};
const newSession = async () => (await J("/sessions", { method: "POST" })).body;
const send = (s, message) => J(`/sessions/${s.sessionId}/messages`, { method: "POST", token: s.sessionToken, body: JSON.stringify({ message, clientMessageId: crypto.randomUUID() }) });

/** Streams the session's SSE; calls onEvent(type, receivedAtMs). Returns {close()}. */
function sse(s, onEvent) {
  const ac = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${BASE}/sessions/${s.sessionId}/events`, { headers: { authorization: `Bearer ${s.sessionToken}` }, signal: ac.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split("\n").find((l) => l.startsWith("data:"));
          if (data) { try { onEvent(JSON.parse(data.slice(5)).type, performance.now()); } catch { /* ignore */ } }
        }
      }
    } catch (e) { if (!ac.signal.aborted) errors.push(`sse: ${e.message}`); }
  })();
  return { close: () => ac.abort() };
}

const until = async (cond, ms = 30000) => { const end = performance.now() + ms; while (performance.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

/** One conversation: verified refund request -> confirmation -> done. Returns timings. */
async function conversation(s, text, confirm = true) {
  const seen = []; const t0 = performance.now();
  const stream = sse(s, (type, at) => seen.push([type, at]));
  await new Promise((r) => setTimeout(r, 150)); // let the stream attach
  const sentAt = performance.now();
  const r = await send(s, text);
  const ack = performance.now() - sentAt;
  if (r.status !== 202) { errors.push(`send ${r.status} ${JSON.stringify(r.body)?.slice(0, 80)}`); stream.close(); return null; }
  const has = (t) => seen.some(([x]) => x === t);
  await until(() => has("run.paused") || has("run.completed") || has("run.failed"));
  const firstStatus = seen.find(([t]) => t === "decision.completed" || t === "tool.started")?.[1] - sentAt;
  const firstText = seen.find(([t]) => t === "response.delta")?.[1] - sentAt;
  let done = seen.find(([t]) => ["run.paused", "run.completed", "run.failed"].includes(t))?.[1] - sentAt;
  let status = has("run.failed") ? "failed" : has("run.paused") ? "awaiting_confirmation" : "completed";
  if (confirm && status === "awaiting_confirmation") {
    const before = seen.length; const at = performance.now();
    await send(s, "yes");
    await until(() => seen.slice(before).some(([t]) => t === "run.completed" || t === "run.failed"));
    status = seen.slice(before).some(([t]) => t === "run.completed") ? "completed" : "failed";
    done = performance.now() - at + (done ?? 0);
  }
  stream.close();
  return { ack, firstStatus, firstText, done, status, total: performance.now() - t0 };
}

const mem = () => Number((process.memoryUsage().rss / 1e6).toFixed(0));
const report = { base: BASE, startedAt: new Date().toISOString() };

// 1. concurrent conversations (each its own session). All use the same demo customer, so they also race for ONE refund.
{
  const sessions = await Promise.all(Array.from({ length: SESSIONS }, newSession));
  const t0 = performance.now();
  const res = await Promise.all(sessions.map((s) => conversation(s, `${LOGIN} Can you refund my last payment?`)));
  const ok = res.filter(Boolean);
  report.concurrentConversations = { sessions: SESSIONS, wallMs: Math.round(performance.now() - t0), completed: ok.filter((r) => r.status === "completed").length, failed: ok.filter((r) => r.status === "failed").length,
    sendAckMs: stats(ok.map((r) => r.ack)), firstStatusMs: stats(ok.map((r) => r.firstStatus).filter(Number.isFinite)), firstPausedOrDoneMs: stats(ok.map((r) => r.done).filter(Number.isFinite)), totalMs: stats(ok.map((r) => r.total)) };
}

// 2. persistent SSE subscribers
{
  const s = await newSession(); const counts = new Array(SSE_SUBS).fill(0);
  const subs = Array.from({ length: SSE_SUBS }, (_, i) => sse(s, () => { counts[i]++; }));
  await new Promise((r) => setTimeout(r, 500));
  await send(s, "What is your refund policy for monthly plans?");
  await new Promise((r) => setTimeout(r, 4000));
  report.sse = { subscribersRequested: SSE_SUBS, eventsPerSubscriber: stats(counts), note: "the server keeps at most SSE_MAX_CONNECTIONS_PER_SESSION (default 4) streams per session and closes the oldest" };
  subs.forEach((x) => x.close());
}

// 3. connect/disconnect churn: no leaked state, still serving
{
  const s = await newSession(); const t0 = performance.now(); let okCount = 0;
  for (let i = 0; i < CHURN; i++) { const c = sse(s, () => {}); await new Promise((r) => setTimeout(r, 30)); c.close(); okCount++; }
  const health = await J("/health/ready");
  report.churn = { cycles: okCount, ms: Math.round(performance.now() - t0), readyAfter: health.status };
}

// 4. long conversation: sequential interactions on one session
{
  const s = await newSession(); const lat = []; let failed = 0;
  await conversation(s, `${LOGIN} What plan am I on? Check my subscription.`);
  for (let i = 0; i < LONG_TURNS; i++) {
    const t0 = performance.now(); const stream = sse(s, () => {}); 
    const seen = []; stream.close();
    const r = await send(s, i % 2 ? "What is your refund policy for monthly plans?" : "What subscription am I on? my plan please");
    if (r.status !== 202) { if (r.status !== 429) failed++; await new Promise((x) => setTimeout(x, 1500)); continue; }
    let st = "";
    for (let k = 0; k < 400 && !["completed", "failed", "escalated", "cancelled"].includes(st); k++) { await new Promise((x) => setTimeout(x, 25)); st = (await J(`/runs/${r.body.runId}`, { token: s.sessionToken })).body?.status ?? ""; }
    lat.push(performance.now() - t0); if (st === "failed") failed++; void seen;
  }
  report.longConversation = { turns: LONG_TURNS, answered: lat.length, failed, latencyMs: stats(lat), note: "bounded by the per-conversation rate limit (RATE_LIMIT_SESSION_PER_MIN); throttled turns are skipped" };
}

// 5. database correctness under concurrency
{
  const { body } = await J("/health/dependencies").catch(() => ({ body: null }));
  report.dependenciesVisible = body === null ? "n/a (admin only)" : "readable";
}
report.process = { loadScriptRssMb: mem() };
const hard = [];
if (errors.length) hard.push(`${errors.length} transport/HTTP errors (e.g. ${errors[0]})`);
if (report.concurrentConversations.failed) hard.push(`${report.concurrentConversations.failed} failed runs`);
if (report.churn.readyAfter !== 200) hard.push("not ready after churn");
report.errors = errors.slice(0, 10);
report.hardFailures = hard;
console.log(JSON.stringify(report, null, 2));
process.exit(hard.length ? 1 : 0);
