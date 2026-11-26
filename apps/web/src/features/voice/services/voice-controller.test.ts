import type { VoiceClientMessage, VoiceEvent, VoiceServerEventType, VoiceSessionView } from "@support-ai/contracts";
import { describe, expect, it, vi } from "vitest";
import { MicrophoneError } from "../audio/microphone.service";
import { initialVoiceState, reduceVoiceEvent } from "./voice-event-reducer";
import type { VoiceState } from "../types";
import { VoiceController, type MicLike, type PlayerLike, type VoiceControllerDeps } from "./voice-controller";
import type { SocketHandlers, VoiceSocket } from "./voice-socket.service";

const session = (id = "vs1"): VoiceSessionView => ({ sessionId: "s1", voiceSessionId: id, status: "connecting", websocketPath: "/ws/voice", ticket: "tk", maxSessionMinutes: 10, audio: { inputSampleRate: 16000, outputSampleRate: 24000, chunkDurationMs: 40 } });
const ev = (type: VoiceServerEventType, payload: unknown = {}): VoiceEvent => ({ eventId: "e", sessionId: "s1", voiceSessionId: "vs1", type, timestamp: "t", payload });

function harness(over: Partial<VoiceControllerDeps> & { micError?: Error } = {}) {
  let state: VoiceState = initialVoiceState();
  const store = { get: () => state, apply: (e: VoiceEvent) => { state = reduceVoiceEvent(state, e); }, patch: (p: Partial<VoiceState>) => { state = { ...state, ...p }; }, reset: () => { state = initialVoiceState(); } };
  const sent: VoiceClientMessage[] = [];
  const audio: ArrayBuffer[] = [];
  const sockets: Array<{ h: SocketHandlers; closed: boolean }> = [];
  const mic = { enabled: true as boolean, stopped: false, setEnabled(v: boolean) { this.enabled = v; }, async stop() { this.stopped = true; }, analyser: null } satisfies MicLike & { enabled: boolean; stopped: boolean };
  let onFrame: (b: ArrayBuffer) => void = () => {};
  const player: PlayerLike & { generation: number; cleared: number; disposed: boolean; frames: Array<[number, number]> } = {
    generation: 1, cleared: 0, disposed: false, frames: [], analyser: null, isPlaying: false,
    async init() {}, enqueue(g, s) { player.frames.push([g, s]); }, setGeneration(g) { player.generation = g; player.cleared++; }, clear() { player.cleared++; }, async dispose() { player.disposed = true; },
  };
  const api = { create: vi.fn(async () => session()), reconnect: vi.fn(async () => session()), end: vi.fn(async () => ({ ended: true })) };
  const openSocket = (_u: string, _t: string, h: SocketHandlers): VoiceSocket => {
    const rec = { h, closed: false };
    sockets.push(rec);
    queueMicrotask(h.onOpen);
    return { send: (m) => { sent.push(m); }, sendAudio: (b) => { audio.push(b); }, close: () => { rec.closed = true; }, bufferedAmount: 0, isOpen: !rec.closed };
  };
  const c = new VoiceController({
    conversation: { id: "s1", token: "tok" }, store, api, sleep: async () => {}, reconnectDelaysMs: [1, 1, 1], openSocket,
    openMic: async (o) => { if (over.micError) throw over.micError; onFrame = o.onFrame; return mic; },
    createPlayer: () => player,
    ...over,
  } as VoiceControllerDeps);
  const connect = async () => { const p = c.start(); await vi.waitFor(() => expect(sockets.length).toBe(1)); sockets[0]!.h.onEvent(ev("voice.connected", { resumed: false })); await p; };
  return { c, store, sent, audio, sockets, mic, player, api, connect, frame: (n = 1280) => onFrame(new ArrayBuffer(n)), get state() { return state; } };
}

describe("VoiceController", () => {
  it("asks for the microphone before creating a backend session and never transmits before voice.connected", async () => {
    const h = harness();
    const p = h.c.start();
    await vi.waitFor(() => expect(h.sockets.length).toBe(1));
    h.frame(); // backend has not confirmed yet
    expect(h.audio).toHaveLength(0);
    expect(h.sent[0]).toEqual({ type: "voice.start" });
    h.sockets[0]!.h.onEvent(ev("voice.connected", { resumed: false }));
    await p;
    h.frame();
    expect(h.audio).toHaveLength(1);
    expect(h.state.connectionStatus).toBe("connected");
  });

  it("releases the microphone and offers chat when permission is denied (no backend session is created)", async () => {
    const h = harness({ micError: new MicrophoneError("PERMISSION_DENIED", "Microphone access was blocked.") });
    await h.c.start();
    expect(h.api.create).not.toHaveBeenCalled();
    expect(h.state).toMatchObject({ connectionStatus: "failed", error: { code: "PERMISSION_DENIED", recoverable: true } });
    expect(h.player.disposed).toBe(true);
  });

  it("releases everything and reports failure when the backend cannot set up voice", async () => {
    const h = harness();
    const p = h.c.start();
    await vi.waitFor(() => expect(h.sockets.length).toBe(1));
    h.sockets[0]!.h.onEvent(ev("voice.error", { code: "PROVIDER_UNAVAILABLE", message: "Voice is unavailable.", recoverable: false }));
    await p;
    expect(h.state.connectionStatus).toBe("failed");
    expect(h.mic.stopped).toBe(true);
    expect(h.player.disposed).toBe(true);
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.api.end).toHaveBeenCalled();
  });

  it("mute stops transmission at the source and tells the server; the assistant stays audible", async () => {
    const h = harness();
    await h.connect();
    h.c.setMuted(true);
    expect(h.mic.enabled).toBe(false);
    h.frame();
    expect(h.audio).toHaveLength(0);
    expect(h.sent).toContainEqual({ type: "voice.mute" });
    h.sockets[0]!.h.onAudio({ generationId: 1, sequence: 1, pcm: new Uint8Array(4) });
    expect(h.player.frames).toEqual([[1, 1]]);
    h.c.setMuted(false);
    h.frame();
    expect(h.audio).toHaveLength(1);
    expect(h.sent).toContainEqual({ type: "voice.unmute" });
  });

  it("push to talk transmits only while held", async () => {
    const h = harness();
    await h.connect();
    h.c.setPushToTalk(true);
    h.frame();
    expect(h.audio).toHaveLength(0);
    h.c.holdToTalk(true);
    h.frame();
    h.c.holdToTalk(false);
    h.frame();
    expect(h.audio).toHaveLength(1);
  });

  it("keeps the server's mute state in step when push to talk is switched off after a hold", async () => {
    const h = harness();
    await h.connect();
    h.c.setPushToTalk(true);
    h.c.holdToTalk(true);
    h.c.holdToTalk(false); // server is now muted
    h.sent.length = 0;
    h.c.setPushToTalk(false);
    expect(h.sent).toContainEqual({ type: "voice.unmute" });
  });

  it("clears playback before anything else when the server reports an interruption", async () => {
    const h = harness();
    await h.connect();
    h.sockets[0]!.h.onEvent(ev("voice.interrupted", { previousGenerationId: 1, nextGenerationId: 2, clearPlayback: true, reason: "customer_barge_in" }));
    expect(h.player.generation).toBe(2);
    expect(h.state.audioGenerationId).toBe(2);
    h.c.interrupt();
    expect(h.sent).toContainEqual({ type: "voice.interrupt" });
  });

  it("re-attaches with a fresh ticket after an unexpected socket drop, then resumes", async () => {
    const h = harness();
    await h.connect();
    h.sockets[0]!.h.onClose(1006);
    await vi.waitFor(() => expect(h.sockets.length).toBe(2));
    expect(h.state.connectionStatus).toBe("reconnecting");
    expect(h.api.reconnect).toHaveBeenCalledWith("vs1", "tok");
    h.frame();
    expect(h.audio).toHaveLength(0); // nothing is sent while reconnecting
    h.sockets[1]!.h.onEvent(ev("voice.connected", { resumed: true }));
    await vi.waitFor(() => expect(h.state.connectionStatus).toBe("connected"));
    h.frame();
    expect(h.audio).toHaveLength(1);
  });

  it("falls back to chat after the reconnect budget is spent", async () => {
    const h = harness();
    await h.connect();
    h.api.reconnect.mockRejectedValue(new Error("down"));
    h.sockets[0]!.h.onClose(1006);
    await vi.waitFor(() => expect(h.state.connectionStatus).toBe("failed"));
    expect(h.api.reconnect).toHaveBeenCalledTimes(3);
    expect(h.state.error?.code).toBe("RECOVERY_FAILED");
    expect(h.mic.stopped).toBe(true);
    expect(h.player.disposed).toBe(true);
  });

  it("ending voice releases the microphone, playback, and socket exactly once", async () => {
    const h = harness();
    await h.connect();
    await h.c.end();
    await h.c.end();
    expect(h.sent.filter((m) => m.type === "voice.end")).toHaveLength(1);
    expect(h.mic.stopped).toBe(true);
    expect(h.player.disposed).toBe(true);
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.state.connectionStatus).toBe("disconnected");
  });

  it("when the server ends voice (limit reached) it releases resources and keeps the notice", async () => {
    const h = harness();
    await h.connect();
    h.sockets[0]!.h.onEvent(ev("voice.disconnected", { reason: "max_session_duration", fallbackToChat: true }));
    await vi.waitFor(() => expect(h.mic.stopped).toBe(true));
    expect(h.state.connectionStatus).toBe("disconnected");
    expect(h.state.notice).toMatch(/time limit/);
  });
});
