import type { VoiceEvent, VoiceServerEventType } from "@support-ai/contracts";
import { describe, expect, it } from "vitest";
import { initialVoiceState, reduceVoiceEvent } from "./voice-event-reducer";

const ev = (type: VoiceServerEventType, payload: unknown = {}): VoiceEvent => ({ eventId: "e", sessionId: "s", voiceSessionId: "v", type, timestamp: "t", payload });
const run = (events: VoiceEvent[]) => events.reduce(reduceVoiceEvent, { ...initialVoiceState(), connectionStatus: "connecting" as const });

describe("voice event reducer", () => {
  it("walks the happy path: connected, user speaks, processing, assistant speaks, listening", () => {
    let s = run([ev("voice.connected", { resumed: false })]);
    expect([s.connectionStatus, s.activity]).toEqual(["connected", "listening"]);
    s = reduceVoiceEvent(s, ev("voice.transcript.delta", { role: "user", text: "Can you", turnId: "t1" }));
    expect([s.activity, s.partialUserTranscript]).toEqual(["user_speaking", "Can you"]);
    s = reduceVoiceEvent(s, ev("voice.transcript.delta", { role: "user", text: "Can you refund me", turnId: "t1" }));
    expect(s.partialUserTranscript).toBe("Can you refund me"); // cumulative, not appended
    s = reduceVoiceEvent(s, ev("voice.transcript.completed", { role: "user", text: "Can you refund me?", turnId: "t1" }));
    expect([s.partialUserTranscript, s.transcript.map((t) => t.text)]).toEqual(["", ["Can you refund me?"]]);
    s = reduceVoiceEvent(s, ev("voice.processing", { turnId: "t1", runId: "r1" }));
    expect([s.activity, s.activeRunId]).toEqual(["processing", "r1"]);
    s = reduceVoiceEvent(s, ev("voice.speaking", { turnId: "t1", generationId: 1 }));
    expect(s.activity).toBe("assistant_speaking");
    s = reduceVoiceEvent(s, ev("voice.transcript.completed", { role: "assistant", text: "Yes.", turnId: "t1" }));
    s = reduceVoiceEvent(s, ev("voice.listening"));
    expect([s.activity, s.transcript.map((t) => t.role)]).toEqual(["listening", ["user", "assistant"]]);
  });

  it("is idempotent for a repeated completed event", () => {
    const e = ev("voice.transcript.completed", { role: "user", text: "hi", turnId: "t1" });
    expect(run([ev("voice.connected"), e, e]).transcript).toHaveLength(1);
  });

  it("barge-in advances the audio generation, drops the partial reply and returns to the customer", () => {
    let s = run([ev("voice.connected"), ev("voice.speaking", { turnId: "t", generationId: 1 }), ev("voice.transcript.delta", { role: "assistant", text: "Your pay", turnId: "t" })]);
    s = reduceVoiceEvent(s, ev("voice.interrupted", { previousGenerationId: 1, nextGenerationId: 2, clearPlayback: true, reason: "customer_barge_in" }));
    expect([s.audioGenerationId, s.partialAssistantTranscript, s.activity]).toEqual([2, "", "user_speaking"]);
    s = reduceVoiceEvent(s, ev("voice.interrupted", { previousGenerationId: 1, nextGenerationId: 2, clearPlayback: true, reason: "customer_barge_in" }));
    expect(s.audioGenerationId).toBe(2);
  });

  it("tracks reconnection and recovery", () => {
    let s = run([ev("voice.connected"), ev("voice.reconnecting", { attempt: 2, maxAttempts: 3, delayMs: 10 })]);
    expect([s.connectionStatus, s.reconnectAttempts]).toEqual(["reconnecting", 2]);
    s = reduceVoiceEvent(s, ev("voice.connected", { resumed: true }));
    expect([s.connectionStatus, s.reconnectAttempts]).toEqual(["connected", 0]);
  });

  it("recoverable errors keep voice running; unrecoverable ones fail it", () => {
    let s = run([ev("voice.connected"), ev("voice.error", { code: "INVALID_AUDIO", message: "x", recoverable: true })]);
    expect([s.connectionStatus, s.error?.code]).toEqual(["connected", "INVALID_AUDIO"]);
    s = reduceVoiceEvent(s, ev("voice.error", { code: "RECOVERY_FAILED", message: "y", recoverable: false }));
    expect(s.connectionStatus).toBe("failed");
  });

  it("explains a server-side end and points back to chat", () => {
    const s = run([ev("voice.connected"), ev("voice.disconnected", { reason: "max_session_duration", fallbackToChat: true })]);
    expect([s.connectionStatus, s.notice]).toEqual(["disconnected", expect.stringContaining("time limit")]);
    expect(run([ev("voice.connected"), ev("voice.disconnected", { reason: "client_end", fallbackToChat: false })]).notice).toBeNull();
  });
});
