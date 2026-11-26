import type { VoiceError, VoiceEvent, VoiceSessionView } from "@support-ai/contracts";
import { AudioPlayer } from "../audio/audio-player";
import { Microphone, MicrophoneError } from "../audio/microphone.service";
import type { VoiceStoreApi } from "../store/voice.store";
import { createVoiceSession, endVoiceSession, reconnectVoiceSession, voiceSocketUrl } from "./voice.service";
import { openVoiceSocket, type SocketFactory, type VoiceSocket } from "./voice-socket.service";

export interface MicLike { analyser: AnalyserNode | null; setEnabled(v: boolean): void; stop(): Promise<void> }
export interface PlayerLike {
  init(): Promise<void>; enqueue(g: number, s: number, pcm: Uint8Array): unknown; setGeneration(g: number): void; clear(): void; dispose(): Promise<void>;
  readonly analyser: AnalyserNode | null; readonly isPlaying: boolean;
}

export interface VoiceControllerDeps {
  conversation: { id: string; token: string };
  store: VoiceStoreApi;
  /** Called after transcripts or when voice ends, so the chat history can refetch. */
  onActivity?: () => void;
  openSocket?: SocketFactory;
  openMic?: (o: { outputSampleRate: number; chunkMs: number; onFrame: (b: ArrayBuffer) => void }) => Promise<MicLike>;
  createPlayer?: (h: { onStarted: (g: number) => void; onIdle: (g: number) => void }) => PlayerLike;
  api?: { create: typeof createVoiceSession; reconnect: typeof reconnectVoiceSession; end: typeof endVoiceSession };
  sleep?: (ms: number) => Promise<void>;
  /** Backoff for client-side socket recovery. */
  reconnectDelaysMs?: number[];
}

const PING_MS = 10_000;

/**
 * Owns everything that is not serializable: the microphone, AudioContexts, the WebSocket and timers. React only sees
 * the Zustand store. The rules it enforces:
 *  - nothing is transmitted until the backend says the provider session is ready (voice.connected);
 *  - muted or push-to-talk-idle audio is dropped at the worklet, not just ignored by the server;
 *  - after any failure or end, every resource (tracks, worklet, contexts, socket, timers) is released.
 */
export class VoiceController {
  private socket: VoiceSocket | null = null;
  private mic: MicLike | null = null;
  private player: PlayerLike | null = null;
  private session: VoiceSessionView | null = null;
  private canSend = false;
  private ending = false;
  private starting = false;
  private recovering = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private rttMs: number | undefined;
  private waitingConnected: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private readonly d: Required<Pick<VoiceControllerDeps, "openSocket" | "openMic" | "createPlayer" | "api" | "sleep" | "reconnectDelaysMs">> & VoiceControllerDeps;

  constructor(deps: VoiceControllerDeps) {
    this.d = {
      ...deps,
      openSocket: deps.openSocket ?? openVoiceSocket,
      openMic: deps.openMic ?? ((o) => Microphone.open(o)),
      createPlayer: deps.createPlayer ?? ((h) => new AudioPlayer({ onStarted: h.onStarted, onIdle: h.onIdle, initialBufferMs: 100 })),
      api: deps.api ?? { create: createVoiceSession, reconnect: reconnectVoiceSession, end: endVoiceSession },
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      reconnectDelaysMs: deps.reconnectDelaysMs ?? [1000, 2000, 4000],
    };
  }

  get micAnalyser(): AnalyserNode | null { return this.mic?.analyser ?? null; }
  get outputAnalyser(): AnalyserNode | null { return this.player?.analyser ?? null; }
  get isActive(): boolean { return this.starting || this.session !== null; }

  // ---- start -------------------------------------------------------------------------------------------------------------
  async start(): Promise<void> {
    const { store, conversation } = this.d;
    if (this.starting || (this.session && !this.ending)) return;
    this.starting = true;
    this.ending = false;
    store.reset();
    store.patch({ sessionId: conversation.id, connectionStatus: "connecting", activity: "idle" });
    let micSeen: Microphone | MicLike | null = null;
    try {
      // Created inside the click handler so the browser allows audio output.
      this.player = this.d.createPlayer({ onStarted: (g) => this.socket?.send({ type: "voice.playback.started", generationId: g, at: Date.now() }), onIdle: (g) => this.onPlaybackIdle(g) });
      await this.player.init();
      // Ask for the microphone before creating any backend session: a denial costs nothing and leaves no orphan.
      this.mic = micSeen = await this.d.openMic({ outputSampleRate: 16_000, chunkMs: 40, onFrame: (b) => this.onMicFrame(b) });
      const session = await this.d.api.create(conversation.id, conversation.token);
      this.session = session;
      store.patch({ voiceSessionId: session.voiceSessionId });
      await this.connectSocket(session);
      this.startPing();
    } catch (err) {
      this.starting = false;
      await this.fail(err);
      void micSeen;
      return;
    }
    this.starting = false;
  }

  /** Opens the socket, sends voice.start, and resolves once the backend confirms the provider session is ready. */
  private connectSocket(session: VoiceSessionView): Promise<void> {
    if (!session.ticket) return Promise.reject(new Error("The server did not issue a voice ticket."));
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { this.waitingConnected = null; reject(new Error("Voice took too long to connect.")); }, 15_000);
      this.waitingConnected = { resolve: () => { clearTimeout(timeout); resolve(); }, reject: (e) => { clearTimeout(timeout); reject(e); } };
      this.socket = this.d.openSocket(voiceSocketUrl(session.websocketPath), session.ticket!, {
        onOpen: () => this.socket?.send({ type: "voice.start" }),
        onEvent: (e) => this.onEvent(e),
        onAudio: (f) => this.onAudio(f),
        onClose: (code) => this.onSocketClose(code),
      });
    });
  }

  // ---- inbound ------------------------------------------------------------------------------------------------------------
  private onEvent(e: VoiceEvent): void {
    const { store } = this.d;
    if (e.type === "voice.pong") {
      const t = (e.payload as { t?: number }).t;
      if (t) this.rttMs = Math.max(0, Date.now() - t);
      return;
    }
    if (e.type === "voice.interrupted") {
      // Clear obsolete audio first, then update state: this is the barge-in latency path.
      const p = e.payload as { nextGenerationId: number };
      this.player?.setGeneration(p.nextGenerationId);
    }
    store.apply(e);
    if (e.type === "voice.connected") {
      this.canSend = !store.get().isMuted && !store.get().pushToTalk;
      this.mic?.setEnabled(this.canSend);
      this.waitingConnected?.resolve();
      this.waitingConnected = null;
    }
    if (e.type === "voice.error" && !(e.payload as VoiceError).recoverable) this.waitingConnected?.reject(new Error((e.payload as VoiceError).message));
    if (e.type === "voice.transcript.completed" || e.type === "voice.listening") this.d.onActivity?.();
    if (e.type === "voice.disconnected") void this.teardown(false);
  }

  private onAudio(f: { generationId: number; sequence: number; pcm: Uint8Array }): void {
    this.player?.enqueue(f.generationId, f.sequence, f.pcm);
  }

  private onPlaybackIdle(generationId: number): void {
    this.socket?.send({ type: "voice.playback.completed", generationId, at: Date.now() });
  }

  private onMicFrame(pcm: ArrayBuffer): void {
    if (!this.canSend || !this.socket?.isOpen) return;
    this.socket.sendAudio(pcm);
  }

  // ---- controls -----------------------------------------------------------------------------------------------------------
  /** Mute is independent of everything else: the customer keeps hearing the assistant. */
  setMuted(muted: boolean): void {
    this.d.store.patch({ isMuted: muted });
    this.applyMicGate();
    this.socket?.send({ type: muted ? "voice.mute" : "voice.unmute" });
  }

  setPushToTalk(enabled: boolean): void {
    this.d.store.patch({ pushToTalk: enabled });
    this.applyMicGate();
    // Each release mutes the server; turning push to talk off must unmute it or the open mic is silently dropped.
    if (!this.d.store.get().isMuted) this.socket?.send({ type: enabled ? "voice.mute" : "voice.unmute" });
  }

  /** Push-to-talk: transmit only while held. */
  holdToTalk(held: boolean): void {
    const { pushToTalk, isMuted } = this.d.store.get();
    if (!pushToTalk || isMuted) return;
    this.canSend = held;
    this.mic?.setEnabled(held);
    this.socket?.send({ type: held ? "voice.unmute" : "voice.mute" });
  }

  private applyMicGate(): void {
    const { isMuted, pushToTalk, connectionStatus } = this.d.store.get();
    this.canSend = connectionStatus === "connected" && !isMuted && !pushToTalk;
    this.mic?.setEnabled(this.canSend);
  }

  /** Explicit "stop talking": same effect as a barge-in. */
  interrupt(): void {
    this.player?.clear();
    this.socket?.send({ type: "voice.interrupt" });
  }

  // ---- end and failure ----------------------------------------------------------------------------------------------------
  async end(): Promise<void> {
    if (this.ending) return;
    this.ending = true;
    this.socket?.send({ type: "voice.end" });
    await this.teardown(true);
  }

  /** Releases microphone, worklet, AudioContexts, socket and timers. Safe to call twice. */
  private async teardown(resetStore: boolean): Promise<void> {
    this.canSend = false;
    this.ending = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.waitingConnected?.reject(new Error("Voice ended."));
    this.waitingConnected = null;
    const mic = this.mic, player = this.player, socket = this.socket;
    this.mic = null; this.player = null; this.socket = null; this.session = null;
    socket?.close();
    await Promise.allSettled([mic?.stop(), player?.dispose()]);
    this.d.onActivity?.();
    if (resetStore) {
      const { notice } = this.d.store.get();
      this.d.store.reset();
      if (notice) this.d.store.patch({ notice });
    }
  }

  private async fail(err: unknown): Promise<void> {
    const e = err instanceof MicrophoneError
      ? { code: e0(err.code), message: err.message, recoverable: true }
      : { code: "CLIENT" as const, message: err instanceof Error ? err.message : "Voice could not be started.", recoverable: true };
    const sessionId = this.session?.voiceSessionId;
    await this.teardown(false);
    if (sessionId) void this.d.api.end(this.d.conversation.id, this.d.conversation.token).catch(() => undefined);
    this.d.store.patch({ connectionStatus: "failed", activity: "idle", error: e, isMuted: false });
    this.ending = false;
  }

  // ---- recovery ----------------------------------------------------------------------------------------------------------
  /** The browser socket dropped. The provider session may still be alive on the server: re-attach with a fresh ticket. */
  private onSocketClose(code: number): void {
    if (this.ending || this.recovering || !this.session) return;
    if (this.waitingConnected) { this.waitingConnected.reject(new Error(`Voice connection closed (${code}).`)); this.waitingConnected = null; return; }
    void this.recover();
  }

  private async recover(): Promise<void> {
    const { store, conversation } = this.d;
    const session = this.session;
    if (!session) return;
    this.recovering = true;
    this.canSend = false;
    this.player?.clear();
    const max = this.d.reconnectDelaysMs.length;
    for (let attempt = 1; attempt <= max && !this.ending; attempt++) {
      store.patch({ connectionStatus: "reconnecting", reconnectAttempts: attempt, maxReconnectAttempts: max, activity: "idle" });
      await this.d.sleep(this.d.reconnectDelaysMs[attempt - 1]!);
      if (this.ending) return;
      try {
        const next = await this.d.api.reconnect(session.voiceSessionId, conversation.token);
        this.socket?.close();
        await this.connectSocket(next);
        this.recovering = false;
        return;
      } catch {
        /* try again */
      }
    }
    this.recovering = false;
    if (this.ending) return;
    await this.teardown(false);
    store.patch({ connectionStatus: "failed", activity: "idle", error: { code: "RECOVERY_FAILED", message: "We couldn't restore the voice connection. Your conversation is saved, so you can continue in chat.", recoverable: false } });
    this.ending = false;
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => this.socket?.send({ type: "voice.ping", t: Date.now(), ...(this.rttMs !== undefined ? { rttMs: this.rttMs } : {}) }), PING_MS);
  }
}

const e0 = (c: MicrophoneError["code"]) => c;
