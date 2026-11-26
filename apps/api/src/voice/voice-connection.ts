import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import {
  encodeAudioFrame, voiceClientMessageSchema,
  type VoiceError, type VoiceEvent, type VoiceEventPayloads, type VoiceMetricsView, type VoiceServerEventType,
} from "@support-ai/contracts";
import { recordSpan } from "../observability/tracing/tracing.js";
import { AudioOutputGate } from "./audio/audio-output-gate.js";
import { InputBudget, validateInputFrame } from "./audio/audio-validation.js";
import { AgentDelegationService } from "./delegation/agent-delegation.service.js";
import { FunctionCallHandler } from "./delegation/function-call-handler.js";
import { SUPPORT_TOOL_NAME, VOICE_SYSTEM_INSTRUCTION } from "./delegation/support-tool.definition.js";
import { verifyGrounding } from "./grounding/grounding-verifier.js";
import { VoiceMetrics } from "./observability/voice-metrics.js";
import type { LiveProvider, LiveSession, ProviderEvent, ProviderFunctionCall } from "./providers/live-provider.js";
import type { VoiceSessionRecord, VoiceSessionRepository } from "./session/voice-session.repository.js";
import type { VoiceConfig } from "./voice.config.js";

/** The browser socket, reduced to what the orchestrator needs (a ws WebSocket in production, a fake in tests). */
export interface VoiceSocket {
  readonly isOpen: boolean;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array, binary: boolean): void;
  close(code?: number, reason?: string): void;
}

export interface VoiceConnectionDeps {
  cfg: VoiceConfig;
  provider: LiveProvider;
  repo: VoiceSessionRepository;
  delegation: AgentDelegationService;
  recentMessages: (sessionId: string, limit: number) => Promise<Array<{ role: string; content: string }>>;
}

type Phase = "listening" | "awaiting_delegation" | "delegated" | "speaking_approved" | "done";
interface Turn {
  id: string;
  user: string;
  spoken: string;
  canonical: string | null;
  phase: Phase;
  interrupted: boolean;
  startedAt: number;
  lastInputAt: number;
  audioSent: boolean;
  violations: number;
  runId?: string;
  userCompleted: boolean;
  /** Serializes this turn's database writes: the row must exist before anything references it. */
  chain: Promise<unknown>;
  watchdog?: NodeJS.Timeout;
}

const CODE_RE = /\b\d(?:[\s-]?\d){5}\b/g;
/** Verification codes spoken aloud are masked before they are shown, stored or logged (the agent masks them too). */
export const maskCodes = (s: string): string => s.replace(CODE_RE, "[CODE]");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_FRAME_OUT = 9_600;
const GRACE_MS = 20_000;

export const speakApprovedPrompt = (text: string): string =>
  `Say the following to the customer, word for word, in a natural spoken voice, and nothing else. Do not add or change any fact:\n"""${text}"""`;

/**
 * One customer's live voice session: the browser socket on one side, a replaceable provider session on the other.
 * It is the only place that knows about both, and it keeps the rules that make voice safe:
 *  - the provider only ever calls resolve_support_request; the backend runs the real agent with the stored identity;
 *  - provider audio reaches the browser only through the AudioOutputGate (after a verified answer exists);
 *  - what the model actually says is checked against that answer, and corrected or blocked if it drifts;
 *  - interruptions bump an audio generation so obsolete audio can never play, and reconcile business actions;
 *  - the provider session is disposable: pending actions and history live in PostgreSQL/LangGraph.
 */
export class VoiceConnection {
  private readonly logger = new Logger(`VoiceConnection`);
  readonly metrics: VoiceMetrics;
  private readonly gate = new AudioOutputGate();
  private readonly budget: InputBudget;
  private readonly calls: FunctionCallHandler;

  private socket: VoiceSocket | null;
  private session: LiveSession | null = null;
  private activeSid = 0;
  private sidCounter = 0;
  private ready = false;
  private ending = false;
  private recovering = false;
  private muted = false;
  private audioLost = false;
  private audioViolations = 0;
  private resumptionHandle: string | null;
  private epoch = 1;
  private audioSeq = 0;
  private turn: Turn | null = null;
  private lastRunId: string | undefined;
  private lastActivity = Date.now();
  private lastUserSpeechAt = 0;
  private backpressureNotified = false;
  private pendingPlaybackFor: number | null = null;
  private timers: NodeJS.Timeout[] = [];
  private graceTimer: NodeJS.Timeout | null = null;
  private background = new Set<Promise<unknown>>();
  private startPromise: Promise<void> | null = null;

  constructor(
    readonly record: VoiceSessionRecord,
    socket: VoiceSocket,
    private readonly deps: VoiceConnectionDeps,
    private readonly onClosed: (id: string) => void,
  ) {
    this.socket = socket;
    this.resumptionHandle = record.resumptionHandle;
    this.metrics = new VoiceMetrics(deps.cfg, deps.provider.model);
    this.budget = new InputBudget(deps.cfg.maxInputBytesPerSec);
    this.calls = new FunctionCallHandler((turnId, request, onRun) => this.delegate(turnId, request, onRun), deps.cfg.toolTimeoutMs, { onDuplicate: () => { this.metrics.duplicateCalls += 1; } });
  }

  get id(): string { return this.record.id; }
  get sessionId(): string { return this.record.sessionId; }
  get isEnded(): boolean { return this.ending; }
  get currentGeneration(): number { return this.epoch; }
  metricsView(): VoiceMetricsView { return this.metrics.view(this.id); }
  /** Resolves when background work (tool calls, persistence) has settled; used by tests and graceful shutdown. */
  async idle(): Promise<void> { while (this.background.size) await Promise.allSettled(this.background); }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------------
  attach(socket: VoiceSocket): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    const old = this.socket;
    this.socket = socket;
    if (old && old !== socket && old.isOpen) old.close(1000, "replaced");
  }

  /** The browser socket dropped without ending voice. Keep the provider session for a grace period so the page can reattach. */
  detach(socket: VoiceSocket): void {
    if (this.socket !== socket || this.ending) return;
    this.socket = null;
    this.graceTimer = setTimeout(() => void this.end("browser_disconnected", false), GRACE_MS);
  }

  /** Called on the browser's voice.start. Idempotent: a reattaching browser just learns the session is ready. */
  start(): Promise<void> {
    if (this.ready) {
      this.emit("voice.connected", this.connectedPayload(true));
      return Promise.resolve();
    }
    this.startPromise ??= this.doStart().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  /** Voice spans share one trace per voice session; the delegated agent runs have their own run traces, linked by voice_turns.run_id. */
  private span(name: string, start: number, attrs: Record<string, string | number | boolean | undefined> = {}, o: { ok?: boolean; errorCode?: string; runId?: string } = {}): void {
    try {
      recordSpan({ name, category: "voice", traceKey: this.id, start, end: Date.now(), sessionId: this.sessionId, voiceSessionId: this.id, attrs, ...(o.ok === false ? { ok: false, errorCode: o.errorCode ?? "VOICE_ERROR" } : {}), ...(o.runId ? { runId: o.runId } : {}) });
    } catch { /* telemetry never affects the call */ }
  }

  private async doStart(): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.connectProvider(this.resumptionHandle ?? undefined, true);
    } catch (err) {
      const e = err as { rateLimited?: boolean; timeout?: boolean; message?: string };
      const error: VoiceError = e.timeout
        ? { code: "PROVIDER_SETUP_TIMEOUT", message: "Voice is taking too long to connect. You can retry or continue in chat.", recoverable: true }
        : e.rateLimited ? { code: "PROVIDER_RATE_LIMITED", message: "Voice is busy right now. Please retry shortly or continue in chat.", recoverable: true }
        : { code: "PROVIDER_UNAVAILABLE", message: "Voice is unavailable right now. You can continue in chat.", recoverable: true };
      this.logger.warn(`voice setup failed for ${this.id}: ${e.message ?? "unknown"}`);
      this.span("voice.connect", startedAt, { model: this.deps.provider.model }, { ok: false, errorCode: error.code });
      this.emit("voice.error", error);
      await this.end("setup_failed", true, "failed");
      return;
    }
    this.metrics.connected();
    this.span("voice.connect", startedAt, { model: this.deps.provider.model, resumed: Boolean(this.resumptionHandle) });
    await this.deps.repo.setStatus(this.id, "connected");
    this.armTimers();
    await this.restoreContext();
    this.emit("voice.connected", this.connectedPayload(false));
    this.emit("voice.listening", {});
  }

  private connectedPayload(resumed: boolean): VoiceEventPayloads["voice.connected"] {
    const c = this.deps.cfg;
    return { model: this.deps.provider.model, inputSampleRate: c.inputSampleRate, outputSampleRate: c.outputSampleRate, chunkDurationMs: c.chunkDurationMs, resumed };
  }

  private armTimers(): void {
    this.timers.push(setTimeout(() => void this.end("max_session_duration", true), this.deps.cfg.maxSessionMs));
    this.timers.push(setInterval(() => {
      if (!this.recovering && Date.now() - this.lastActivity > this.deps.cfg.idleTimeoutMs) {
        this.emit("voice.error", { code: "IDLE_TIMEOUT", message: "Voice ended because it was quiet for a while.", recoverable: true });
        void this.end("idle_timeout", true);
      }
    }, Math.max(250, Math.min(10_000, this.deps.cfg.idleTimeoutMs / 4))));
  }

  async end(reason: string, fallbackToChat: boolean, status: "ended" | "failed" = "ended"): Promise<void> {
    if (this.ending) return;
    this.ending = true;
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); }
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.turn?.watchdog) clearTimeout(this.turn.watchdog);
    this.gate.close();
    // In-flight agent runs are NOT cancelled here: an answer (or a committed action) must survive the voice session.
    try { this.session?.close(); } catch { /* already closed */ }
    this.session = null;
    this.ready = false;
    // Persist the final state first, so whoever hears "disconnected" can rely on the database already saying so.
    await this.persistUsage();
    await this.deps.repo.setStatus(this.id, status, { endReason: reason }).catch(() => undefined);
    await this.deps.repo.event(this.id, "voice.disconnected", { reason, fallbackToChat });
    this.emit("voice.disconnected", { reason, fallbackToChat });
    const s = this.socket;
    this.socket = null;
    if (s?.isOpen) s.close(1000, reason.slice(0, 100));
    this.onClosed(this.id);
  }

  private async persistUsage(): Promise<void> {
    const secs = this.metrics.audioSeconds();
    const view = this.metrics.view(this.id);
    await this.deps.repo.saveUsage(this.id, {
      audioInputSeconds: secs.input, audioOutputSeconds: secs.output, ...view.usage, pricingModel: this.deps.provider.model,
      pricingEffectiveDate: ((c) => (c.status === "ok" ? c.snapshot.effectiveFrom : null))(this.metrics.estimatedCost(this.deps.provider.model)), metrics: view,
    }).catch((e: unknown) => this.logger.error(`could not persist voice usage: ${e instanceof Error ? e.message : String(e)}`));
  }

  // ---- provider connection ------------------------------------------------------------------------------------------------
  private async connectProvider(handle: string | undefined, initial: boolean): Promise<void> {
    const sid = ++this.sidCounter;
    let readyResolve!: () => void;
    const readyP = new Promise<void>((r) => { readyResolve = r; });
    const early: ProviderEvent[] = [];
    let activated = false;
    const onEvent = (e: ProviderEvent) => {
      if (sid === this.activeSid) return this.dispatch(e);
      if (e.type === "ready") { readyResolve(); return; }
      if (!activated && sid === this.sidCounter) early.push(e);
    };
    const session = await this.deps.provider.connect({ systemInstruction: VOICE_SYSTEM_INSTRUCTION, voice: this.deps.cfg.voice, onEvent, ...(handle ? { resumptionHandle: handle } : {}) });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        readyP,
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("provider setup timed out"), { timeout: true })), this.deps.cfg.providerSetupTimeoutMs); }),
      ]);
    } catch (err) {
      session.close();
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const previous = this.session;
    this.session = session;
    this.activeSid = sid;
    activated = true;
    this.ready = true;
    if (previous && previous !== session) { try { previous.close(); } catch { /* ignore */ } }
    for (const e of early) this.dispatch(e);
    void initial;
  }

  /** A fresh provider session knows nothing: give it the recent conversation as silent context (no reply expected). */
  private async restoreContext(): Promise<void> {
    if (!this.session) return;
    try {
      const recent = await this.deps.recentMessages(this.sessionId, 6);
      if (!recent.length) return;
      const lines = recent.map((m) => `${m.role === "user" ? "Customer" : "SupportAI"}: ${maskCodes(m.content).slice(0, 400)}`).join("\n");
      this.session.sendText(`Context only, do not respond to it. Recent conversation:\n${lines}`, { turnComplete: false });
    } catch (err) {
      this.logger.warn(`context restore failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Bounded, backed-off recovery. Resumes with the latest handle; if that is rejected, starts clean and restores context. */
  private async recover(reason: string): Promise<void> {
    if (this.ending || this.recovering) return;
    this.recovering = true;
    this.ready = false;
    this.gate.close();
    this.session = null;
    await this.deps.repo.setStatus(this.id, "reconnecting").catch(() => undefined);
    const { maxReconnectAttempts: max, reconnectBaseDelayMs: base, reconnectMaxDelayMs: cap } = this.deps.cfg;
    let handle = this.resumptionHandle ?? undefined;
    for (let attempt = 1; attempt <= max && !this.ending; attempt++) {
      const delayMs = Math.min(cap, base * 2 ** (attempt - 1));
      this.metrics.reconnects += 1;
      const attemptStart = Date.now();
      this.emit("voice.reconnecting", { attempt, maxAttempts: max, delayMs });
      void this.deps.repo.event(this.id, "voice.reconnecting", { attempt, reason });
      await sleep(delayMs);
      if (this.ending) return;
      try {
        await this.connectProvider(handle, false);
        this.span("voice.reconnect", attemptStart, { attempt, resumed: Boolean(handle), reason: reason.slice(0, 80) });
        this.recovering = false;
        await this.deps.repo.setStatus(this.id, "connected").catch(() => undefined);
        if (!handle) await this.restoreContext();
        this.turn = null; // whatever was in flight on the old session is gone; the agent's state is in PostgreSQL
        this.emit("voice.connected", this.connectedPayload(Boolean(handle)));
        if (this.audioLost) {
          this.audioLost = false;
          this.emit("voice.error", { code: "AUDIO_LOST", message: "I lost part of what you said. Please say that again.", recoverable: true });
        }
        this.emit("voice.listening", {});
        return;
      } catch (err) {
        const e = err as { rateLimited?: boolean };
        this.span("voice.reconnect", attemptStart, { attempt, resumed: Boolean(handle) }, { ok: false, errorCode: e.rateLimited ? "PROVIDER_RATE_LIMITED" : "PROVIDER_UNAVAILABLE" });
        if (handle) { handle = undefined; this.resumptionHandle = null; } // invalid or expired handle: next attempt is a new session
        if (e.rateLimited) this.emit("voice.error", { code: "PROVIDER_RATE_LIMITED", message: "Voice is busy; retrying.", recoverable: true });
      }
    }
    this.recovering = false;
    if (!this.ending) {
      this.emit("voice.error", { code: "RECOVERY_FAILED", message: "We couldn't restore the voice connection. Your conversation is saved, so you can continue in chat.", recoverable: false });
      await this.end("recovery_failed", true, "failed");
    }
  }

  /** The provider asked us to move before the connection closes: bring up a replacement and swap without dropping the turn. */
  private async replaceProvider(): Promise<void> {
    if (this.recovering || this.ending) return;
    try {
      await this.connectProvider(this.resumptionHandle ?? undefined, false);
    } catch (err) {
      this.logger.warn(`proactive provider replacement failed (${err instanceof Error ? err.message : String(err)}); will recover on close`);
    }
  }

  // ---- browser -> backend --------------------------------------------------------------------------------------------------
  onClientText(raw: string): void {
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return this.emit("voice.error", { code: "INVALID_AUDIO", message: "Malformed control message.", recoverable: true }); }
    const parsed = voiceClientMessageSchema.safeParse(json);
    if (!parsed.success) return this.emit("voice.error", { code: "INTERNAL", message: "Unknown control message.", recoverable: true });
    const m = parsed.data;
    switch (m.type) {
      case "voice.start": void this.start(); break;
      case "voice.mute": this.muted = true; this.session?.sendAudioStreamEnd(); break;
      case "voice.unmute": this.muted = false; this.touch(); break;
      case "voice.interrupt": this.touch(); this.interrupt("client_request"); break;
      case "voice.end": void this.end("client_end", false); break;
      case "voice.ping":
        if (m.rttMs !== undefined) this.metrics.rttMs = m.rttMs;
        this.emit("voice.pong", { ...(m.t !== undefined ? { t: m.t } : {}), serverTime: Date.now() });
        break;
      case "voice.playback.started":
        if (this.pendingPlaybackFor !== null && m.generationId === this.epoch) {
          this.metrics.firstPlayback = Date.now() - this.pendingPlaybackFor;
          this.pendingPlaybackFor = null;
        }
        break;
      case "voice.playback.completed": break;
    }
  }

  onClientAudio(frame: Uint8Array): void {
    if (this.ending) return;
    if (this.muted) return;
    if (!this.ready || this.recovering || !this.session) {
      // Never buffer: replaying seconds of old speech into a new session would answer a question the customer has moved on from.
      this.metrics.droppedFrames += 1;
      this.audioLost = true;
      return;
    }
    const check = validateInputFrame(frame);
    if (!check.ok) {
      this.metrics.droppedFrames += 1;
      if (++this.audioViolations === 1) this.emit("voice.error", { code: "INVALID_AUDIO", message: `Rejected a malformed audio frame (${check.reason}).`, recoverable: true });
      if (this.audioViolations > 50) void this.end("invalid_audio", true, "failed");
      return;
    }
    if (!this.budget.take(frame.byteLength)) {
      this.metrics.droppedFrames += 1;
      if (++this.audioViolations === 1) this.emit("voice.error", { code: "AUDIO_RATE_LIMIT", message: "Audio is arriving faster than real time.", recoverable: true });
      if (this.audioViolations > 200) void this.end("audio_flood", true, "failed");
      return;
    }
    this.metrics.inputBytes += frame.byteLength;
    this.metrics.inputFrames += 1;
    this.session.sendAudio(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
  }

  // ---- provider -> backend: one message can carry several things, every one is handled ------------------------------------------
  private dispatch(e: ProviderEvent): void {
    try {
      switch (e.type) {
        case "ready": this.touch(); break;
        case "interrupted": this.interrupt("customer_barge_in"); break;
        case "toolCancellation": this.onToolCancellation(e.ids); break;
        case "inputTranscript": this.onInputTranscript(e.text); break;
        case "outputTranscript": this.onOutputTranscript(e.text); break;
        case "toolCall": this.onToolCall(e.calls); break;
        case "audio": this.onProviderAudio(e.pcm); break;
        case "usage": this.metrics.addUsage(e.usage); break;
        case "resumptionHandle":
          if (e.resumable) { this.resumptionHandle = e.handle; void this.deps.repo.saveProviderState(this.id, { handle: e.handle }).catch(() => undefined); }
          break;
        case "goAway": this.bg(this.replaceProvider()); break;
        case "generationComplete": break;
        case "turnComplete": this.onTurnComplete(); break;
        case "error":
          this.logger.warn(`provider error: ${e.message}`);
          if (e.rateLimited) this.emit("voice.error", { code: "PROVIDER_RATE_LIMITED", message: "Voice is busy; slowing down.", recoverable: true });
          break;
        case "closed": if (!this.ending) this.bg(this.recover(`provider closed: ${e.reason}`)); break;
      }
    } catch (err) {
      this.logger.error(`provider event ${e.type} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  }

  private touch(): void { this.lastActivity = Date.now(); }
  private bg<T>(p: Promise<T>): void {
    const t: Promise<unknown> = p.catch((err: unknown) => this.logger.error(`voice background task failed: ${err instanceof Error ? err.message : String(err)}`)).finally(() => this.background.delete(t));
    this.background.add(t);
  }

  // ---- turns ------------------------------------------------------------------------------------------------------------------
  private write(t: Turn, fn: () => Promise<unknown>): void {
    t.chain = t.chain.then(fn);
    this.bg(t.chain);
  }

  private startTurn(): Turn {
    if (this.turn?.watchdog) clearTimeout(this.turn.watchdog);
    const t: Turn = { id: `vt_${randomUUID()}`, user: "", spoken: "", canonical: null, phase: "listening", interrupted: false, startedAt: Date.now(), lastInputAt: Date.now(), audioSent: false, violations: 0, userCompleted: false, chain: Promise.resolve() };
    this.turn = t;
    this.gate.close();
    this.write(t, () => this.deps.repo.upsertTurn({ id: t.id, voiceSessionId: this.id, sessionId: this.sessionId }));
    return t;
  }

  private onInputTranscript(text: string): void {
    this.touch();
    let t = this.turn;
    // Late fragments of the utterance that already triggered the tool call belong to that turn. New speech while the
    // assistant is audibly speaking (or after the turn finished) is a new turn.
    if (!t || t.phase === "done" || (t.audioSent && t.phase !== "listening")) {
      if (t && t.audioSent && t.phase !== "done") this.interrupt("customer_barge_in");
      t = this.startTurn();
    }
    t.user += text;
    t.lastInputAt = Date.now();
    this.lastUserSpeechAt = t.lastInputAt;
    this.emit("voice.transcript.delta", { role: "user", text: maskCodes(t.user), turnId: t.id }, { turnId: t.id });
  }

  private completeUserTranscript(t: Turn): void {
    if (t.userCompleted || !t.user.trim()) return;
    t.userCompleted = true;
    const text = maskCodes(t.user.trim());
    this.emit("voice.transcript.completed", { role: "user", text, turnId: t.id }, { turnId: t.id });
    this.write(t, () => this.deps.repo.updateTurn(t.id, { userTranscript: text }));
  }

  private onToolCall(calls: ProviderFunctionCall[]): void {
    this.touch();
    for (const call of calls) {
      let t = this.turn;
      if (!t || t.phase === "done" || t.phase === "delegated" || t.phase === "speaking_approved") t = this.startTurn();
      t.phase = "awaiting_delegation";
      this.metrics.toolCalls += 1;
      this.gate.close();
      this.emit("voice.processing", { turnId: t.id }, { turnId: t.id });
      this.write(t, () => this.deps.repo.recordCall({ voiceSessionId: this.id, providerCallId: call.id, turnId: t.id, name: call.name }));
      this.bg(this.runCall(call, t));
    }
  }

  private async runCall(call: ProviderFunctionCall, t: Turn): Promise<void> {
    const response = await this.calls.handle(call, { turnId: t.id });
    const status = !response ? "cancelled" : response.response.success === false ? "failed" : "completed";
    await t.chain.catch(() => undefined);
    await this.deps.repo.finishCall(this.id, call.id, status, this.calls.runIdFor(t.id)).catch(() => undefined);
    if (!response) return; // cancelled by an interruption: the provider already dropped the call
    if (this.turn !== t || t.interrupted || this.ending || !this.session) return;
    t.phase = "delegated";
    this.gate.open(t.id);
    this.armWatchdog(t);
    this.session.sendToolResponse([{ id: response.id, name: response.name, response: response.response }]);
  }

  /** Executes the delegated request. Runs inside FunctionCallHandler (deduplicated, timed out, cancellable). */
  private async delegate(turnId: string, request: string, onRun: (runId: string) => void): Promise<Record<string, unknown>> {
    const t = this.turn;
    // Transcription can trail the function call by a few hundred ms. What the customer actually said beats the model's paraphrase.
    for (let i = 0; i < 6 && t && !t.user.trim(); i++) await sleep(100);
    const text = t?.user.trim() ? t.user.trim() : request;
    if (t) this.completeUserTranscript(t);
    await this.deps.delegation.settle(this.lastRunId, 8_000);
    const res = await this.deps.delegation.resolveRequest({ sessionId: this.sessionId, voiceSessionId: this.id, turnId }, text, {
      timeoutMs: this.deps.cfg.toolTimeoutMs - 1_000,
      onRun: (runId) => { this.lastRunId = runId; if (t) t.runId = runId; onRun(runId); this.emit("voice.processing", { turnId, runId }, { turnId, runId }); },
    });
    this.metrics.agentExecution(res.durationMs);
    if (res.runId) this.lastRunId = res.runId;
    if (t) {
      t.canonical = res.answer;
      this.write(t, async () => {
        await this.deps.repo.updateTurn(turnId, { assistantCanonical: res.answer, ...(res.runId ? { runId: res.runId } : {}), grounding: "pending" });
        if (res.runId) await this.deps.repo.linkRun(turnId, res.runId);
      });
    }
    return {
      success: res.status !== "failed" && res.status !== "busy" && res.status !== "timeout" && res.status !== "handover",
      status: res.status,
      spokenResponse: res.answer,
      ...(res.pendingAction ? { pendingAction: { summary: res.pendingAction.summary } } : {}),
      ...(res.escalationTicketId ? { escalationTicketId: res.escalationTicketId } : {}),
    };
  }

  private armWatchdog(t: Turn): void {
    if (t.watchdog) clearTimeout(t.watchdog);
    t.watchdog = setTimeout(() => {
      // The model never spoke the verified answer. Show it as text rather than leave the customer in silence.
      if (this.turn !== t || t.audioSent || t.phase === "done") return;
      this.emit("voice.transcript.completed", { role: "assistant", text: t.canonical ?? "", turnId: t.id }, { turnId: t.id });
      this.finish(t, "blocked");
    }, 10_000);
  }

  // ---- audio out ---------------------------------------------------------------------------------------------------------------
  private onProviderAudio(pcm: Buffer): void {
    this.touch();
    const t = this.turn;
    if (!t || t.phase === "done" || !this.gate.admit(t.id, pcm.length)) { this.metrics.gatedBytes += pcm.length; return; }
    const s = this.socket;
    if (!s?.isOpen) return;
    if (s.bufferedAmount > this.deps.cfg.maxBufferedBytes) {
      // The browser cannot keep up. Drop stale audio instead of letting seconds of it queue in memory.
      this.metrics.droppedFrames += 1;
      if (!this.backpressureNotified) { this.backpressureNotified = true; this.emit("voice.backpressure", { dropped: true, message: "Audio is being dropped because the connection is slow." }); }
      return;
    }
    this.backpressureNotified = false;
    if (!t.audioSent) {
      t.audioSent = true;
      this.metrics.timeToFirstAudio(Date.now() - (this.lastUserSpeechAt || t.startedAt));
      this.pendingPlaybackFor = this.lastUserSpeechAt || t.startedAt;
      if (t.watchdog) clearTimeout(t.watchdog);
      this.emit("voice.speaking", { turnId: t.id, generationId: this.epoch }, { turnId: t.id });
    }
    for (let off = 0; off < pcm.length; off += MAX_FRAME_OUT) {
      const part = pcm.subarray(off, Math.min(pcm.length, off + MAX_FRAME_OUT));
      s.send(encodeAudioFrame(this.epoch, ++this.audioSeq, part), true);
      this.metrics.outputBytes += part.length;
    }
  }

  private onOutputTranscript(text: string): void {
    const t = this.turn;
    if (!t || !this.gate.isOpenFor(t.id) || t.canonical === null) return; // pre-verification chatter is neither shown nor stored
    this.touch();
    t.spoken += text;
    this.emit("voice.transcript.delta", { role: "assistant", text: t.spoken, turnId: t.id }, { turnId: t.id });
    const verdict = verifyGrounding(t.canonical, t.spoken);
    if (!verdict.ok) this.bg(this.groundingViolation(t, verdict.reason));
  }

  private async groundingViolation(t: Turn, reason: string): Promise<void> {
    if (this.turn !== t || t.phase === "done") return;
    t.violations += 1;
    this.metrics.groundingCorrections += 1;
    this.logger.warn(`grounding violation in ${t.id}: ${reason}`);
    void this.deps.repo.event(this.id, "grounding.violation", { turnId: t.id, reason, attempt: t.violations });
    this.stopPlayback("grounding_correction");
    if (t.violations === 1 && this.session && t.canonical) {
      t.spoken = "";
      t.audioSent = false;
      t.phase = "speaking_approved";
      this.gate.open(t.id);
      this.armWatchdog(t);
      this.session.sendText(speakApprovedPrompt(t.canonical));
      this.write(t, () => this.deps.repo.updateTurn(t.id, { grounding: "corrected" }));
      return;
    }
    // Still drifting after a correction: stop speaking and show the verified answer as text.
    this.emit("voice.error", { code: "GROUNDING_FAILED", message: "I couldn't read that answer out reliably, so it is shown in the conversation instead.", recoverable: true });
    this.emit("voice.transcript.completed", { role: "assistant", text: t.canonical ?? "", turnId: t.id }, { turnId: t.id });
    this.finish(t, "blocked");
  }

  private onTurnComplete(): void {
    const t = this.turn;
    if (!t) return;
    if (t.phase === "listening") {
      if (t.user.trim()) this.bg(this.fallbackDelegation(t)); // the model answered by itself: that audio was blocked, delegate now
      else this.turn = null;
      return;
    }
    if (t.phase === "awaiting_delegation") return; // the model's turn ended with the function call; the answer is still coming
    if ((t.phase === "delegated" || t.phase === "speaking_approved") && (t.audioSent || t.spoken)) this.finish(t, t.violations ? "corrected" : "verified");
  }

  /** The model skipped delegation. Run the agent ourselves for the transcribed request, then have the model read the approved answer. */
  private async fallbackDelegation(t: Turn): Promise<void> {
    this.logger.warn(`delegation skipped in ${t.id}; running it from the transcript`);
    void this.deps.repo.event(this.id, "delegation.skipped", { turnId: t.id });
    t.phase = "awaiting_delegation";
    this.emit("voice.processing", { turnId: t.id }, { turnId: t.id });
    const call: ProviderFunctionCall = { id: `fallback_${t.id}`, name: SUPPORT_TOOL_NAME, args: { request: t.user.trim() } };
    this.write(t, () => this.deps.repo.recordCall({ voiceSessionId: this.id, providerCallId: call.id, turnId: t.id, name: call.name }));
    this.metrics.toolCalls += 1;
    const response = await this.calls.handle(call, { turnId: t.id });
    await t.chain.catch(() => undefined);
    await this.deps.repo.finishCall(this.id, call.id, response ? "completed" : "cancelled", this.calls.runIdFor(t.id)).catch(() => undefined);
    if (!response || this.turn !== t || t.interrupted || this.ending || !this.session) return;
    const answer = String(response.response.spokenResponse ?? "");
    t.canonical = answer;
    t.phase = "speaking_approved";
    this.gate.open(t.id);
    this.armWatchdog(t);
    this.session.sendText(speakApprovedPrompt(answer));
  }

  private finish(t: Turn, grounding: "verified" | "corrected" | "blocked"): void {
    if (t.phase === "done") return;
    t.phase = "done";
    if (t.watchdog) clearTimeout(t.watchdog);
    this.gate.close();
    const spoken = t.spoken.trim() || (grounding === "blocked" ? "" : t.canonical ?? "");
    if (t.spoken.trim()) this.emit("voice.transcript.completed", { role: "assistant", text: t.spoken.trim(), turnId: t.id }, { turnId: t.id });
    this.write(t, () => this.deps.repo.updateTurn(t.id, { assistantSpoken: spoken, grounding, complete: true, interrupted: t.interrupted }));
    this.span("voice.turn", t.startedAt, { turn_id: t.id, grounding, interrupted: t.interrupted, violations: t.violations, first_audio_ms: t.audioSent ? this.metrics.view(this.id).timeToFirstAudioMs ?? undefined : undefined }, t.runId ? { runId: t.runId } : {});
    this.bg(this.persistUsage()); // keep diagnostics current while the session is live, not only when it ends
    if (this.turn === t) this.turn = null;
    this.emit("voice.listening", {});
  }

  // ---- interruption ----------------------------------------------------------------------------------------------------------
  /** Clears obsolete audio at the browser immediately: the new generation id makes any in-flight frame stale. */
  private stopPlayback(reason: VoiceEventPayloads["voice.interrupted"]["reason"]): void {
    const started = Date.now();
    this.span("voice.interruption", started, { reason, generation: this.epoch + 1 });
    const previous = this.epoch;
    this.epoch += 1;
    this.audioSeq = 0;
    this.gate.close();
    this.emit("voice.interrupted", { previousGenerationId: previous, nextGenerationId: this.epoch, clearPlayback: true, reason });
    this.metrics.interruptionLatency(Date.now() - started);
    this.metrics.interruptions += 1;
  }

  private interrupt(reason: VoiceEventPayloads["voice.interrupted"]["reason"]): void {
    this.touch();
    this.stopPlayback(reason);
    const t = this.turn;
    if (!t || t.phase === "done") return;
    // A turn whose answer was never even started has nothing to mark: it is simply superseded by the customer's new request.
    t.interrupted = true;
    const inflight = t.phase === "awaiting_delegation" ? this.calls.cancelTurn(t.id) : null;
    const runId = inflight?.runId ?? t.runId;
    t.phase = "done";
    if (t.watchdog) clearTimeout(t.watchdog);
    this.turn = null;
    if (t.spoken.trim()) this.emit("voice.transcript.completed", { role: "assistant", text: t.spoken.trim(), turnId: t.id, interrupted: true }, { turnId: t.id });
    this.write(t, () => this.deps.repo.updateTurn(t.id, { assistantSpoken: t.spoken.trim(), interrupted: true, complete: true }));
    if (runId) this.bg(this.reconcile(runId, t));
  }

  private onToolCancellation(ids: string[]): void {
    const cancelled = this.calls.cancel(ids);
    for (const c of cancelled) {
      void this.deps.repo.finishCall(this.id, c.id, "cancelled", c.runId).catch(() => undefined);
      if (c.runId) this.bg(this.reconcile(c.runId, null));
    }
  }

  /** Interrupting speech is not cancelling a transaction: see AgentDelegationService.reconcileInterrupted for the rules. */
  private async reconcile(runId: string, t: Turn | null): Promise<void> {
    const outcome = await this.deps.delegation.reconcileInterrupted(runId);
    void this.deps.repo.event(this.id, "interruption.reconciled", { runId, outcome });
    if (t) await this.deps.repo.markInterruptedMessage(runId, { reason: "customer_barge_in", spokenSoFar: t.spoken.trim().slice(0, 500), outcome }).catch(() => undefined);
  }

  // ---- events out -------------------------------------------------------------------------------------------------------------
  private emit<K extends VoiceServerEventType>(type: K, payload: K extends keyof VoiceEventPayloads ? VoiceEventPayloads[K] : unknown, ids: { turnId?: string; runId?: string } = {}): void {
    const event: VoiceEvent = { eventId: randomUUID(), sessionId: this.sessionId, voiceSessionId: this.id, ...ids, type, timestamp: new Date().toISOString(), payload };
    if (type === "voice.error" || type === "voice.interrupted" || type === "voice.connected") void this.deps.repo.event(this.id, type, payload);
    const s = this.socket;
    if (s?.isOpen) s.send(JSON.stringify(event), false);
  }

}
