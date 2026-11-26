import { describe, expect, it } from "vitest";
import { normalizeRealtimeEvent } from "./openai-realtime.events.js";
import { upsamplePcm16 } from "./resample.js";

const pcm = (...s: number[]) => {
  const b = Buffer.alloc(s.length * 2);
  s.forEach((v, i) => b.writeInt16LE(v, i * 2));
  return b;
};

describe("OpenAI Realtime adapter", () => {
  it("upsamples 16 kHz to 24 kHz with interpolation", () => {
    const out = upsamplePcm16(pcm(0, 300, 600, 900), 16_000, 24_000);
    expect(out.length / 2).toBe(6);
    expect([0, 1, 2].map((i) => out.readInt16LE(i * 2))).toEqual([0, 200, 400]);
    expect(upsamplePcm16(pcm(1, 2), 24_000, 24_000)).toEqual(pcm(1, 2));
  });

  it("maps a function-call response to toolCall, usage, then turnComplete", () => {
    const events = normalizeRealtimeEvent({
      type: "response.done",
      response: { output: [{ type: "function_call", call_id: "c1", name: "resolve_support_request", arguments: '{"request":"refund"}' }], usage: { input_tokens: 10, output_tokens: 5, input_token_details: { audio_tokens: 7 }, output_token_details: { audio_tokens: 3 } } },
    });
    expect(events.map((e) => e.type)).toEqual(["toolCall", "usage", "generationComplete", "turnComplete"]);
    expect(events[0]).toEqual({ type: "toolCall", calls: [{ id: "c1", name: "resolve_support_request", args: { request: "refund" } }] });
    expect(events[1]).toEqual({ type: "usage", usage: { inputTokens: 10, outputTokens: 5, audioInputTokens: 7, audioOutputTokens: 3 } });
  });

  it("maps audio, transcripts, barge-in and readiness (GA and beta names)", () => {
    expect(normalizeRealtimeEvent({ type: "response.output_audio.delta", delta: pcm(5).toString("base64") })).toEqual([{ type: "audio", pcm: pcm(5) }]);
    expect(normalizeRealtimeEvent({ type: "response.audio_transcript.delta", delta: "Hi" })).toEqual([{ type: "outputTranscript", text: "Hi" }]);
    expect(normalizeRealtimeEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "refund please" })).toEqual([{ type: "inputTranscript", text: "refund please" }]);
    expect(normalizeRealtimeEvent({ type: "input_audio_buffer.speech_started" })).toEqual([{ type: "interrupted" }]);
    expect(normalizeRealtimeEvent({ type: "session.updated", session: { id: "s1" } })).toEqual([{ type: "ready", providerSessionId: "s1" }]);
    expect(normalizeRealtimeEvent({ type: "rate_limits.updated" })).toEqual([]);
  });
});
