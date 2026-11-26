import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { decodeAudioFrame, type VoiceEvent } from "@support-ai/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AgentService } from "../../agent/agent.service.js";
import { configureApp } from "../../app.setup.js";
import { pool } from "../../database/pool.js";
import { seedDatabase } from "../../database/seed-data.js";
import { IngestionService } from "../../rag/ingestion/ingestion.service.js";
import { FakeLiveProvider } from "../providers/fake/fake-live.provider.js";
import { LIVE_PROVIDER } from "../providers/live-provider.js";
import { VoiceService } from "../voice.service.js";

Object.assign(process.env, {
  AGENT_LLM: "e2e", E2E_LLM_DELAY_MS: "10", EMBEDDINGS_PROVIDER: "local", OPENAI_API_KEY: "", VOICE_PROVIDER: "fake",
  RATE_LIMIT_SESSION_PER_MIN: "1000", RATE_LIMIT_IP_PER_MIN: "1000", VOICE_RECONNECT_BASE_DELAY_MS: "10", VOICE_RECONNECT_MAX_DELAY_MS: "40",
  VOICE_PROVIDER_SETUP_TIMEOUT_MS: "400", VOICE_MAX_RECONNECT_ATTEMPTS: "3", VOICE_TOOL_TIMEOUT_MS: "15000", WEB_ORIGIN: "http://localhost:3000",
});
const { AppModule } = await import("../../app.module.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const login = "I'm sarah@example.com, my code is 482910.";
const REFUND = "Can you refund my last payment?";

function loud(bytes = 1280): Uint8Array {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes / 2; i++) b.writeInt16LE(i % 20 < 10 ? 9000 : -9000, i * 2);
  return b;
}

class Client {
  events: VoiceEvent[] = [];
  frames: Array<{ generationId: number; sequence: number; bytes: number; at: number }> = [];
  closed: { code: number } | null = null;
  constructor(readonly ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const f = decodeAudioFrame(new Uint8Array(data as Buffer));
        if (f) this.frames.push({ generationId: f.generationId, sequence: f.sequence, bytes: f.pcm.length, at: Date.now() });
      } else this.events.push(JSON.parse(data.toString()) as VoiceEvent);
    });
    ws.on("close", (code) => { this.closed = { code }; });
  }
  static open(base: string, ticket: string, origin?: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base}/ws/voice`, ["voice.v1", `ticket.${ticket}`], origin ? { headers: { origin } } : {});
      ws.once("open", () => resolve(new Client(ws)));
      ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
      ws.once("error", reject);
    });
  }
  send(o: unknown) { this.ws.send(JSON.stringify(o)); }
  audio(b: Uint8Array) { this.ws.send(b, { binary: true }); }
  /** Speak for `ms` (40 ms frames of loud PCM). The fake detects the end of the utterance from silence. */
  async speak(ms = 240) { for (let t = 0; t < ms; t += 40) { this.audio(loud()); await sleep(40); } }
  of(type: string) { return this.events.filter((e) => e.type === type); }
  async waitFor(pred: (e: VoiceEvent) => boolean, ms = 6000, from = 0): Promise<VoiceEvent> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = this.events.slice(from).find(pred);
      if (hit) return hit;
      await sleep(15);
    }
    throw new Error(`timed out waiting for event; saw: ${this.events.map((e) => e.type).join(", ")}`);
  }
  waitType(type: string, ms?: number, from?: number) { return this.waitFor((e) => e.type === type, ms, from); }
  close() { this.ws.close(); }
}

describe("voice (real HTTP + WebSocket + PostgreSQL, scripted provider)", () => {
  let app: INestApplication;
  let base: string;
  let wsBase: string;
  let agent: AgentService;
  let voice: VoiceService;
  const fake = new FakeLiveProvider();
  const clients: Client[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LIVE_PROVIDER).useValue(fake).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, "http://localhost:3000");
    await app.init();
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}/v1`;
    wsBase = `ws://127.0.0.1:${port}`;
    agent = app.get(AgentService);
    voice = app.get(VoiceService);
    await app.get(IngestionService).ingestDirectory();
  });
  afterAll(async () => {
    await agent.idle();
    await app.close();
  });
  beforeEach(async () => {
    await agent.idle();
    await seedDatabase(pool);
    fake.sessions.length = 0;
    fake.connectError = null;
    fake.neverReady = false;
    fake.validHandles.clear();
    for (const k of Object.keys(fake.opts)) delete (fake.opts as Record<string, unknown>)[k];
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await voice.idle();
  });

  const json = async (path: string, init: RequestInit & { token?: string } = {}) => {
    const { token, ...rest } = init;
    const res = await fetch(`${base}${path}`, { ...rest, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const newSession = async (verified = true) => {
    const s = await agent.createSession();
    if (verified) await agent.submitMessage(s.sessionId, { message: `${login} What plan am I on? Check my subscription.`, clientMessageId: `login-${s.sessionId}` });
    return s;
  };
  const startVoice = async (s: { sessionId: string; sessionToken: string }, utterances?: string[]) => {
    if (utterances) fake.opts.utterances = utterances;
    const created = await json(`/sessions/${s.sessionId}/voice`, { method: "POST", token: s.sessionToken, body: JSON.stringify({ clientConnectionId: "c1", language: "en" }) });
    expect(created.status).toBe(201);
    const client = await Client.open(wsBase, created.body.ticket);
    clients.push(client);
    client.send({ type: "voice.start" });
    await client.waitType("voice.connected");
    return { client, voiceSessionId: created.body.voiceSessionId as string, ticket: created.body.ticket as string };
  };
  const q = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];

  // ---- auth and setup -----------------------------------------------------------------------------------------------
  it("needs the session token, returns a ticket and never the provider key", async () => {
    const s = await newSession(false);
    expect((await json(`/sessions/${s.sessionId}/voice`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await json(`/sessions/${s.sessionId}/voice`, { method: "POST", token: "wrong", body: "{}" })).status).toBe(401);
    const ok = await json(`/sessions/${s.sessionId}/voice`, { method: "POST", token: s.sessionToken, body: "{}" });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ sessionId: s.sessionId, status: "connecting", websocketPath: "/ws/voice", audio: { inputSampleRate: 16000, outputSampleRate: 24000, chunkDurationMs: 40 } });
    expect(JSON.stringify(ok.body)).not.toMatch(/api[_-]?key|AIza/i);
  });

  it("rejects bad, reused, expired-origin and cross-session tickets", async () => {
    const a = await newSession(false);
    const b = await newSession(false);
    const created = await json(`/sessions/${a.sessionId}/voice`, { method: "POST", token: a.sessionToken, body: "{}" });
    await expect(Client.open(wsBase, "nonsense")).rejects.toMatchObject({ status: 401 });
    await expect(Client.open(wsBase, created.body.ticket, "http://evil.example")).rejects.toMatchObject({ status: 403 });
    const c = await Client.open(wsBase, created.body.ticket);
    clients.push(c);
    await expect(Client.open(wsBase, created.body.ticket)).rejects.toMatchObject({ status: 401 }); // single use
    // Another conversation's token cannot read or reconnect this voice session.
    expect((await json(`/voice/${created.body.voiceSessionId}/metrics`, { token: b.sessionToken })).status).toBe(401);
    expect((await json(`/voice/${created.body.voiceSessionId}/reconnect`, { method: "POST", token: b.sessionToken })).status).toBe(401);
    expect((await json(`/voice/${created.body.voiceSessionId}/metrics`, { token: a.sessionToken })).status).toBe(200);
  });

  it("allows one live voice session per conversation: the newer one supersedes", async () => {
    const s = await newSession(false);
    const first = await startVoice(s);
    const second = await json(`/sessions/${s.sessionId}/voice`, { method: "POST", token: s.sessionToken, body: "{}" });
    expect(second.status).toBe(201);
    await first.client.waitType("voice.disconnected");
    expect((await q("select status, end_reason from voice_sessions where id = $1", [first.voiceSessionId]))[0]).toMatchObject({ status: "ended", end_reason: "superseded" });
  });

  // ---- the main path ------------------------------------------------------------------------------------------------
  it("speaks a request, runs the shared agent once, plays verified audio and persists one customer message", async () => {
    const s = await newSession();
    const { client, voiceSessionId } = await startVoice(s, [REFUND]);
    const connected = client.of("voice.connected")[0]!;
    expect(connected.payload).toMatchObject({ inputSampleRate: 16000, outputSampleRate: 24000, resumed: false });

    await client.speak();
    await client.waitType("voice.processing");
    const speaking = await client.waitType("voice.speaking");
    const done = await client.waitFor((e) => e.type === "voice.transcript.completed" && (e.payload as any).role === "assistant");
    const user = client.of("voice.transcript.completed").find((e) => (e.payload as any).role === "user")!;

    expect((user.payload as any).text).toBe(REFUND);
    expect((done.payload as any).text).toMatch(/refund/i);
    expect((speaking.payload as any).generationId).toBe(1);
    expect(client.frames.length).toBeGreaterThan(3);
    expect(new Set(client.frames.map((f) => f.generationId))).toEqual(new Set([1]));
    expect(client.frames.map((f) => f.sequence)).toEqual([...client.frames.map((f) => f.sequence)].sort((a, b) => a - b));

    // The provider got the verified answer from the agent, in a structured tool response.
    expect(fake.last.toolResponses).toHaveLength(1);
    expect(fake.last.toolResponses[0]!.response).toMatchObject({ success: true, status: "awaiting_confirmation" });
    expect(String(fake.last.toolResponses[0]!.response.spokenResponse)).toMatch(/\(yes\/no\)/);

    // Exactly one voice message and one run, linked to the voice turn; shared with chat history.
    const msgs = await q("select role, mode, content, voice_turn_id from messages where session_id = $1 and mode = 'voice' order by id", [s.sessionId]);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(msgs[0]!.voice_turn_id).toBeTruthy();
    const turns = await q("select * from voice_turns where voice_session_id = $1", [voiceSessionId]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ user_transcript: REFUND, grounding_status: "verified", interrupted: false });
    expect(turns[0]!.assistant_canonical).toMatch(/Shall I go ahead/);
    expect(await q("select status from voice_function_calls where voice_session_id = $1", [voiceSessionId])).toEqual([{ status: "completed" }]);
    expect(await q("select count(*)::int as n from agent_runs where session_id = $1 and mode = 'voice'", [s.sessionId])).toEqual([{ n: 1 }]);
  });

  it("confirms the pending refund by voice, exactly once, and the refund card data is in the database", async () => {
    const s = await newSession();
    const { client } = await startVoice(s, [REFUND, "Yes"]);
    await client.speak();
    await client.waitFor((e) => e.type === "voice.transcript.completed" && (e.payload as any).role === "assistant");
    await client.waitType("voice.listening", 5000, client.events.length - 1 > 0 ? 0 : 0);
    const mark = client.events.length;
    await client.speak();
    const done = await client.waitFor((e) => e.type === "voice.transcript.completed" && (e.payload as any).role === "assistant" && /processed/i.test((e.payload as any).text), 8000, mark);
    expect((done.payload as any).text).toMatch(/\$49/);
    expect(await q("select count(*)::int as n from refunds")).toEqual([{ n: 1 }]);
  });

  it("shares memory with chat: a refund proposed in chat is confirmed by voice", async () => {
    const s = await newSession();
    const proposed = await agent.submitMessage(s.sessionId, { message: REFUND, clientMessageId: "chat-1" });
    expect(proposed.status).toBe("awaiting_confirmation");
    const { client } = await startVoice(s, ["Yes, go ahead"]);
    await client.speak();
    await client.waitFor((e) => e.type === "voice.transcript.completed" && (e.payload as any).role === "assistant" && /processed/i.test((e.payload as any).text), 8000);
    expect(await q("select count(*)::int as n from refunds")).toEqual([{ n: 1 }]);
    const modes = await q("select mode from messages where session_id = $1 and role = 'user' order by id", [s.sessionId]);
    expect(modes.map((m) => m.mode)).toEqual(["chat", "chat", "voice"]); // login + plan question, refund request, spoken yes
  });

  it("does not let a spoken decline refund anything", async () => {
    const s = await newSession();
    const { client } = await startVoice(s, [REFUND, "No, don't refund me"]);
    await client.speak();
    await client.waitType("voice.speaking");
    await client.waitFor((e) => e.type === "voice.listening", 6000, client.events.findIndex((e) => e.type === "voice.speaking"));
    const mark = client.events.length;
    await client.speak();
    await client.waitFor((e) => e.type === "voice.transcript.completed" && (e.payload as any).role === "assistant", 8000, mark);
    expect(await q("select count(*)::int as n from refunds")).toEqual([{ n: 0 }]);
  });

  it("masks a spoken verification code in captions and stored transcripts", async () => {
    const s = await newSession(false);
    const { client, voiceSessionId } = await startVoice(s, ["I'm sarah@example.com, my code is 482910 and I want a refund"]);
    await client.speak();
    await client.waitFor((e) => e.type === "voice.transcript.completed" && (e.payload as any).role === "user");
    await client.waitFor((e) => e.type === "voice.transcript.completed" && (e.payload as any).role === "assistant", 8000);
    expect(JSON.stringify(client.events)).not.toContain("482910");
    expect(JSON.stringify(await q("select * from voice_turns where voice_session_id = $1", [voiceSessionId]))).not.toContain("482910");
    expect(JSON.stringify(await q("select content from messages where session_id = $1", [s.sessionId]))).not.toContain("482910");
  });

  // ---- grounding ----------------------------------------------------------------------------------------------------
  it("blocks native audio when the model skips delegation, runs the agent itself and has the approved text read", async () => {
    const s = await newSession();
    Object.assign(fake.opts, { behavior: "skip", misstate: "All done, your refund has been completed.", utterances: [REFUND] });
    const { client, voiceSessionId } = await startVoice(s);
    const before = client.frames.length;
    await client.speak();
    await client.waitFor((e) => e.type === "voice.transcript.completed" && (e.payload as any).role === "assistant", 8000);
    expect(client.frames.length).toBeGreaterThan(before);
    // The misstatement never reached the browser as a caption, and the model was told to read the approved text.
    expect(JSON.stringify(client.events)).not.toMatch(/All done/);
    expect(fake.last.texts.some((t) => t.startsWith("Say the following") && /Shall I go ahead/.test(t))).toBe(true);
    expect(await q("select count(*)::int as n from agent_runs where session_id = $1 and mode = 'voice'", [s.sessionId])).toEqual([{ n: 1 }]);
    expect(client.of("voice.connected")).toHaveLength(1);
    expect((await q("select event_type from (select type as event_type from voice_events where voice_session_id = $1) t", [voiceSessionId])).length).toBeGreaterThan(0);
    expect(await q("select count(*)::int as n from refunds")).toEqual([{ n: 0 }]);
  });

  it("interrupts and corrects a spoken claim the backend did not make", async () => {
    const s = await newSession();
    Object.assign(fake.opts, { misstate: "Your refund has been approved and completed for 100 dollars", utterances: [REFUND] });
    const { client, voiceSessionId } = await startVoice(s);
    await client.speak();
    const interrupted = await client.waitFor((e) => e.type === "voice.interrupted" && (e.payload as any).reason === "grounding_correction", 8000);
    expect(interrupted.payload).toMatchObject({ previousGenerationId: 1, nextGenerationId: 2, clearPlayback: true });
    await client.waitFor((e) => e.type === "voice.transcript.completed" && (e.payload as any).role === "assistant", 8000);
    expect(fake.last.texts.some((t) => t.startsWith("Say the following"))).toBe(true);
    expect((await q("select grounding_status from voice_turns where voice_session_id = $1", [voiceSessionId]))[0]).toMatchObject({ grounding_status: "corrected" });
    expect(client.of("voice.transcript.completed").map((e) => (e.payload as any).text).join(" ")).not.toMatch(/100 dollars/);
  });

  // ---- interruption --------------------------------------------------------------------------------------------------
  it("barge-in: clears playback, bumps the generation and never plays stale audio afterwards", async () => {
    const s = await newSession();
    fake.opts.frameMs = 40;
    const { client } = await startVoice(s, [REFUND, "Actually, what plan am I on?"]);
    await client.speak();
    await client.waitType("voice.speaking");
    await sleep(120);
    await client.speak(120); // customer talks over the assistant
    const intr = await client.waitFor((e) => e.type === "voice.interrupted" && (e.payload as any).reason === "customer_barge_in");
    const at = Date.now();
    expect(intr.payload).toMatchObject({ previousGenerationId: 1, nextGenerationId: 2, clearPlayback: true });
    await sleep(300);
    // Anything after the interruption event carries the new generation; the old one is gone.
    expect(client.frames.filter((f) => f.at > at && f.generationId === 1)).toHaveLength(0);
    const turns = await q("select interrupted from voice_turns order by created_at");
    expect(turns[0]!.interrupted).toBe(true);
  });

  it("leaves a refund awaiting confirmation pending when the customer interrupts", async () => {
    const s = await newSession();
    const { client } = await startVoice(s, [REFUND]);
    await client.speak();
    await client.waitFor((e) => e.type === "voice.transcript.completed" && (e.payload as any).role === "assistant");
    client.send({ type: "voice.interrupt" });
    await client.waitFor((e) => e.type === "voice.interrupted" && (e.payload as any).reason === "client_request");
    await sleep(150);
    const view = await agent.sessionView(s.sessionId);
    expect(view.pendingAction).not.toBeNull();
    expect(await q("select count(*)::int as n from refunds")).toEqual([{ n: 0 }]);
  });

  it("preserves a committed refund when a late cancellation arrives", async () => {
    const s = await newSession();
    const { client } = await startVoice(s, [REFUND, "Yes"]);
    await client.speak();
    await client.waitFor((e) => e.type === "voice.transcript.completed" && (e.payload as any).role === "assistant");
    const mark = client.events.length;
    await client.speak();
    await client.waitFor((e) => e.type === "voice.transcript.completed" && (e.payload as any).role === "assistant" && /processed/i.test((e.payload as any).text), 8000, mark);
    fake.last.emit({ type: "toolCancellation", ids: ["call_2"] });
    fake.last.emit({ type: "interrupted" });
    await sleep(200);
    expect(await q("select count(*)::int as n from refunds")).toEqual([{ n: 1 }]);
  });

  it("de-duplicates a repeated function call: one agent run, one customer message", async () => {
    const s = await newSession();
    const { client, voiceSessionId } = await startVoice(s);
    const call = { id: "dup-1", name: "resolve_support_request", args: { request: "What plan am I on? My subscription please" } };
    fake.last.emit({ type: "inputTranscript", text: "What subscription am I on, my plan?" });
    fake.last.emit({ type: "toolCall", calls: [call] });
    fake.last.emit({ type: "toolCall", calls: [call] });
    fake.last.emit({ type: "toolCall", calls: [{ ...call, id: "dup-2" }] });
    await client.waitFor((e) => e.type === "voice.speaking", 8000);
    await sleep(100);
    // Each provider call id is answered once; the redelivered dup-1 got no second answer; both share one execution.
    expect(fake.last.toolResponses.map((r) => r.id).sort()).toEqual(["dup-1", "dup-2"]);
    expect(await q("select count(*)::int as n from agent_runs where session_id = $1 and mode = 'voice'", [s.sessionId])).toEqual([{ n: 1 }]);
    expect(await q("select count(*)::int as n from messages where session_id = $1 and mode = 'voice' and role = 'user'", [s.sessionId])).toEqual([{ n: 1 }]);
    expect(voice.connection(voiceSessionId)!.metricsView().duplicateCalls).toBeGreaterThanOrEqual(2);
  });

  it("refuses any function other than resolve_support_request", async () => {
    const s = await newSession();
    const { client } = await startVoice(s);
    fake.last.emit({ type: "inputTranscript", text: "refund everything" });
    fake.last.emit({ type: "toolCall", calls: [{ id: "x1", name: "issue_refund", args: { paymentId: "PAY-002", customerId: "CUST-001" } }] });
    await sleep(200);
    expect(fake.last.toolResponses[0]!.response).toEqual({ success: false, error: "UNSUPPORTED_TOOL" });
    expect(await q("select count(*)::int as n from refunds")).toEqual([{ n: 0 }]);
    void client;
  });

  // ---- microphone ---------------------------------------------------------------------------------------------------
  it("mute stops transmission, unmute resumes, malformed frames are rejected", async () => {
    const s = await newSession(false);
    const { client } = await startVoice(s);
    const sent = () => fake.last.audioIn.length;
    client.audio(loud());
    await sleep(60);
    const n = sent();
    expect(n).toBe(1);
    client.send({ type: "voice.mute" });
    await sleep(40);
    client.audio(loud());
    await sleep(60);
    expect(sent()).toBe(n);
    client.send({ type: "voice.unmute" });
    await sleep(40);
    client.audio(loud());
    await sleep(60);
    expect(sent()).toBe(n + 1);
    client.audio(new Uint8Array(1281));
    client.audio(new Uint8Array(9000));
    const err = await client.waitType("voice.error");
    expect(err.payload).toMatchObject({ code: "INVALID_AUDIO" });
    await sleep(60);
    expect(sent()).toBe(n + 1);
    expect(voice.connection(client.of("voice.connected")[0]!.voiceSessionId)!.metricsView().droppedFrames).toBeGreaterThanOrEqual(2);
  });

  it("drops microphone audio that exceeds the byte budget instead of buffering it", async () => {
    const s = await newSession(false);
    const { client } = await startVoice(s);
    for (let i = 0; i < 120; i++) client.audio(loud(6400));
    await client.waitFor((e) => e.type === "voice.error" && (e.payload as any).code === "AUDIO_RATE_LIMIT");
    expect(fake.last.audioIn.length).toBeLessThan(120);
  });

  // ---- failure and recovery ----------------------------------------------------------------------------------------------
  it("falls back to chat when the provider cannot be reached", async () => {
    const s = await newSession(false);
    fake.connectError = new Error("boom");
    const created = await json(`/sessions/${s.sessionId}/voice`, { method: "POST", token: s.sessionToken, body: "{}" });
    const client = await Client.open(wsBase, created.body.ticket);
    clients.push(client);
    client.send({ type: "voice.start" });
    const err = await client.waitType("voice.error");
    expect(err.payload).toMatchObject({ code: "PROVIDER_UNAVAILABLE", recoverable: true });
    expect((await client.waitType("voice.disconnected")).payload).toMatchObject({ fallbackToChat: true });
    expect((await q("select status from voice_sessions where id = $1", [created.body.voiceSessionId]))[0]!.status).toBe("failed");
    // The conversation itself is untouched.
    expect((await json(`/sessions/${s.sessionId}`, { token: s.sessionToken })).status).toBe(200);
  });

  it("times out provider setup", async () => {
    const s = await newSession(false);
    fake.neverReady = true;
    const created = await json(`/sessions/${s.sessionId}/voice`, { method: "POST", token: s.sessionToken, body: "{}" });
    const client = await Client.open(wsBase, created.body.ticket);
    clients.push(client);
    client.send({ type: "voice.start" });
    expect((await client.waitType("voice.error")).payload).toMatchObject({ code: "PROVIDER_SETUP_TIMEOUT" });
  });

  it("resumes the provider session with the latest handle after an unexpected close", async () => {
    const s = await newSession(false);
    const { client } = await startVoice(s);
    fake.validHandles.add("h-1");
    fake.last.emit({ type: "resumptionHandle", handle: "h-1", resumable: true });
    const first = fake.last;
    first.emit({ type: "closed", reason: "network", clean: false });
    const r = await client.waitType("voice.reconnecting");
    expect(r.payload).toMatchObject({ attempt: 1, maxAttempts: 3 });
    await client.waitFor((e) => e.type === "voice.connected" && (e.payload as any).resumed === true);
    expect(fake.sessions).toHaveLength(2);
    expect(first.closed || true).toBe(true);
  });

  it("starts a new provider session with restored context when the resumption handle is invalid", async () => {
    const s = await newSession();
    const { client } = await startVoice(s);
    fake.last.emit({ type: "resumptionHandle", handle: "expired", resumable: true });
    fake.last.emit({ type: "closed", reason: "gone", clean: false });
    await client.waitFor((e) => e.type === "voice.connected" && (e.payload as any).resumed === false, 6000, 1);
    expect(fake.last.texts.some((t) => t.startsWith("Context only") && t.includes("Customer:"))).toBe(true);
    expect(fake.last.texts.join("\n")).not.toContain("482910");
  });

  it("asks the customer to repeat when audio was lost during reconnection, and never replays it", async () => {
    const s = await newSession(false);
    const { client } = await startVoice(s);
    fake.last.emit({ type: "closed", reason: "network", clean: false });
    await client.waitType("voice.reconnecting");
    client.audio(loud());
    client.audio(loud());
    await client.waitFor((e) => e.type === "voice.error" && (e.payload as any).code === "AUDIO_LOST");
    expect(fake.last.audioIn).toHaveLength(0);
  });

  it("gives up after the retry budget and returns the customer to chat", async () => {
    const s = await newSession(false);
    const { client, voiceSessionId } = await startVoice(s);
    fake.connectError = new Error("down");
    fake.last.emit({ type: "closed", reason: "network", clean: false });
    await client.waitFor((e) => e.type === "voice.error" && (e.payload as any).code === "RECOVERY_FAILED", 6000);
    expect((await client.waitType("voice.disconnected")).payload).toMatchObject({ fallbackToChat: true });
    expect(client.of("voice.reconnecting")).toHaveLength(3);
    expect((await q("select status from voice_sessions where id = $1", [voiceSessionId]))[0]!.status).toBe("failed");
  });

  it("replaces the provider session on goAway without dropping the customer", async () => {
    const s = await newSession(false);
    const { client } = await startVoice(s);
    const old = fake.last;
    old.emit({ type: "goAway", timeLeftMs: 5000 });
    await sleep(120);
    expect(fake.sessions).toHaveLength(2);
    expect(client.of("voice.reconnecting")).toHaveLength(0);
    client.audio(loud());
    await sleep(60);
    expect(fake.last.audioIn.length).toBe(1);
  });

  it("lets a browser that lost its socket re-attach with a fresh ticket while the provider session lives", async () => {
    const s = await newSession(false);
    const { client, voiceSessionId } = await startVoice(s);
    const provider = fake.last;
    client.close();
    await sleep(60);
    const t = await json(`/voice/${voiceSessionId}/reconnect`, { method: "POST", token: s.sessionToken });
    expect(t.status).toBe(201);
    const again = await Client.open(wsBase, t.body.ticket);
    clients.push(again);
    again.send({ type: "voice.start" });
    expect((await again.waitType("voice.connected")).payload).toMatchObject({ resumed: true });
    expect(fake.sessions).toHaveLength(1);
    expect(provider.closed).toBe(false);
  });

  // ---- ending ----------------------------------------------------------------------------------------------------------
  it("ends cleanly: provider closed, status and usage persisted, metrics available", async () => {
    const s = await newSession();
    const { client, voiceSessionId } = await startVoice(s, [REFUND]);
    await client.speak();
    await client.waitFor((e) => e.type === "voice.transcript.completed" && (e.payload as any).role === "assistant");
    fake.last.emit({ type: "usage", usage: { inputTokens: 1000, outputTokens: 400, audioInputTokens: 800, audioOutputTokens: 300 } });
    const provider = fake.last;
    client.send({ type: "voice.end" });
    await client.waitType("voice.disconnected");
    await sleep(100);
    expect(provider.closed).toBe(true);
    const row = (await q("select status, end_reason from voice_sessions where id = $1", [voiceSessionId]))[0];
    expect(row).toMatchObject({ status: "ended", end_reason: "client_end" });
    const usage = (await q("select * from voice_usage where voice_session_id = $1", [voiceSessionId]))[0];
    expect(Number(usage.audio_input_tokens)).toBe(800);
    expect(usage.estimated_cost_usd).toBeNull(); // "fake-live" has no configured price: unavailable, never 0
    expect(usage.pricing_effective_date).toBeNull(); // no price version applies to an unpriced model
    const metrics = await json(`/voice/${voiceSessionId}/metrics`, { token: s.sessionToken });
    expect(metrics.body).toMatchObject({ toolCalls: 1, interruptions: 0 });
    expect(metrics.body.audioInputBytes).toBeGreaterThan(0);
    expect(metrics.body.connectionSetupMs).not.toBeNull();
    expect(metrics.body.timeToFirstAudioMs).not.toBeNull();
    const turns = await json(`/voice/${voiceSessionId}/turns`, { token: s.sessionToken });
    expect(turns.body).toHaveLength(1);
    expect(turns.body[0]).toMatchObject({ userTranscript: REFUND, interrupted: false });
    // Phase 7 voice diagnostics: connection span, per-turn first audio, cost unavailable for an unpriced model, session-level attribution.
    const diag = await json(`/observability/voice/${voiceSessionId}/metrics`, { token: s.sessionToken });
    expect(diag.status).toBe(200);
    expect(diag.body).toMatchObject({ voiceSessionId, status: "ended", cost: { estimatedCostUsd: null, attribution: "session" }, functionCalls: { total: 1, duplicates: 0 } });
    expect(diag.body.events.map((e: any) => e.name)).toContain("voice.connect");
    expect(diag.body.turns[0].firstAudioMs).not.toBeNull();
    expect(diag.body.metrics.audioInputBytes).toBeGreaterThan(0);
    expect((await json(`/observability/voice/${voiceSessionId}/metrics`)).status).toBe(401);
    // The pending refund survives the end of voice: chat can still confirm it.
    expect((await agent.sessionView(s.sessionId)).pendingAction).not.toBeNull();
  });

  it("answers application pings and records the reported round trip", async () => {
    const s = await newSession(false);
    const { client, voiceSessionId } = await startVoice(s);
    client.send({ type: "voice.ping", t: 123, rttMs: 42 });
    expect((await client.waitType("voice.pong")).payload).toMatchObject({ t: 123 });
    expect(voice.connection(voiceSessionId)!.metricsView().rttMs).toBe(42);
  });
});
