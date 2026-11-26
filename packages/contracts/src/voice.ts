import { z } from "zod";

/** Live voice (Phase 6) wire contracts, shared by the NestJS gateway and the browser. Platform-neutral: no Buffer, no DOM. */

export const VOICE_WS_PATH = "/ws/voice";

// ---- audio ---------------------------------------------------------------------------------------------------------
export const VOICE_INPUT_SAMPLE_RATE = 16_000;
export const VOICE_OUTPUT_SAMPLE_RATE = 24_000;
/** Largest microphone frame the server accepts (200 ms of 16 kHz mono PCM16). */
export const VOICE_MAX_INPUT_FRAME_BYTES = 6_400;

/**
 * Binary frames server -> browser: an 8-byte little-endian header followed by raw PCM16 mono at the output sample rate.
 *   bytes 0-3  audioGenerationId (uint32): bumped on every interruption, so stale frames can be rejected
 *   bytes 4-7  sequence (uint32): monotonic within a generation
 * Binary frames browser -> server are raw PCM16 mono at the input sample rate (no header).
 */
export const VOICE_AUDIO_HEADER_BYTES = 8;

export function encodeAudioFrame(generationId: number, sequence: number, pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(VOICE_AUDIO_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, generationId >>> 0, true);
  view.setUint32(4, sequence >>> 0, true);
  out.set(pcm, VOICE_AUDIO_HEADER_BYTES);
  return out;
}

export function decodeAudioFrame(frame: ArrayBuffer | Uint8Array): { generationId: number; sequence: number; pcm: Uint8Array } | null {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength <= VOICE_AUDIO_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { generationId: view.getUint32(0, true), sequence: view.getUint32(4, true), pcm: bytes.subarray(VOICE_AUDIO_HEADER_BYTES) };
}

// ---- events --------------------------------------------------------------------------------------------------------
export const VOICE_CLIENT_EVENT_TYPES = [
  "voice.start", "voice.mute", "voice.unmute", "voice.interrupt", "voice.end", "voice.ping", "voice.playback.started", "voice.playback.completed",
] as const;
export type VoiceClientEventType = (typeof VOICE_CLIENT_EVENT_TYPES)[number];

export const VOICE_SERVER_EVENT_TYPES = [
  "voice.connected", "voice.transcript.delta", "voice.transcript.completed", "voice.processing", "voice.speaking", "voice.listening",
  "voice.interrupted", "voice.reconnecting", "voice.error", "voice.disconnected", "voice.pong", "voice.backpressure",
] as const;
export type VoiceServerEventType = (typeof VOICE_SERVER_EVENT_TYPES)[number];

export const voiceClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("voice.start"), clientConnectionId: z.string().max(100).optional() }),
  z.object({ type: z.literal("voice.mute") }),
  z.object({ type: z.literal("voice.unmute") }),
  z.object({ type: z.literal("voice.interrupt") }),
  z.object({ type: z.literal("voice.end") }),
  z.object({ type: z.literal("voice.ping"), t: z.number().optional(), rttMs: z.number().nonnegative().optional() }),
  z.object({ type: z.literal("voice.playback.started"), generationId: z.number().int().nonnegative(), at: z.number().optional() }),
  z.object({ type: z.literal("voice.playback.completed"), generationId: z.number().int().nonnegative(), at: z.number().optional() }),
]);
export type VoiceClientMessage = z.infer<typeof voiceClientMessageSchema>;

export type VoiceErrorCode =
  | "PROVIDER_UNAVAILABLE" | "PROVIDER_SETUP_TIMEOUT" | "PROVIDER_RATE_LIMITED" | "SESSION_LIMIT" | "SESSION_EXPIRED" | "INVALID_AUDIO"
  | "AUDIO_RATE_LIMIT" | "AUDIO_LOST" | "BACKPRESSURE" | "GROUNDING_FAILED" | "RECOVERY_FAILED" | "IDLE_TIMEOUT" | "INTERNAL";

export interface VoiceError { code: VoiceErrorCode; message: string; recoverable: boolean }

export interface VoiceEvent<T = unknown> {
  eventId: string;
  sessionId: string;
  voiceSessionId: string;
  turnId?: string;
  runId?: string;
  type: VoiceServerEventType;
  timestamp: string;
  payload: T;
}

export interface VoiceEventPayloads {
  "voice.connected": { model: string; inputSampleRate: number; outputSampleRate: number; chunkDurationMs: number; resumed: boolean };
  /** `text` is the full transcript of the turn so far (not an increment), so a lost event never corrupts the caption. */
  "voice.transcript.delta": { role: "user" | "assistant"; text: string; turnId: string };
  "voice.transcript.completed": { role: "user" | "assistant"; text: string; turnId: string; interrupted?: boolean };
  "voice.processing": { turnId: string; runId?: string };
  "voice.speaking": { turnId: string; generationId: number };
  "voice.listening": Record<string, never>;
  "voice.interrupted": { previousGenerationId: number; nextGenerationId: number; clearPlayback: true; reason: "customer_barge_in" | "client_request" | "grounding_correction" | "reconnect" };
  "voice.reconnecting": { attempt: number; maxAttempts: number; delayMs: number };
  "voice.error": VoiceError;
  "voice.disconnected": { reason: string; fallbackToChat: boolean };
  "voice.pong": { t?: number; serverTime: number };
  "voice.backpressure": { dropped: boolean; message: string };
}

// ---- REST ----------------------------------------------------------------------------------------------------------
export const createVoiceSessionSchema = z.object({
  clientConnectionId: z.string().trim().min(1).max(100).default(() => "client"),
  language: z.string().trim().min(2).max(10).default("en"),
  voice: z.string().trim().min(1).max(40).optional(),
});
export type CreateVoiceSessionInput = z.input<typeof createVoiceSessionSchema>;

export type VoiceSessionStatus = "connecting" | "connected" | "reconnecting" | "ended" | "failed";

export interface VoiceSessionView {
  sessionId: string;
  voiceSessionId: string;
  status: VoiceSessionStatus;
  websocketPath: string;
  /** Short-lived, single-use WebSocket ticket. Never the provider API key. */
  ticket?: string;
  ticketExpiresAt?: string;
  maxSessionMinutes: number;
  audio: { inputSampleRate: number; outputSampleRate: number; chunkDurationMs: number };
}

export interface VoiceMetricsView {
  voiceSessionId: string;
  connectionSetupMs: number | null;
  timeToFirstAudioMs: number | null;
  interruptionLatencyMs: number | null;
  agentExecutionMs: number | null;
  audioInputBytes: number;
  audioInputFrames: number;
  droppedFrames: number;
  audioOutputBytes: number;
  toolCalls: number;
  duplicateCalls: number;
  reconnectAttempts: number;
  interruptions: number;
  staleAudioDropped: number;
  rttMs: number | null;
  /** Browser-reported: from the end of the customer's speech to the first audio actually played. */
  timeToFirstPlaybackMs: number | null;
  gatedAudioBytes: number;
  groundingCorrections: number;
  usage: { inputTokens: number; outputTokens: number; audioInputTokens: number; audioOutputTokens: number; /** Fixed-precision USD string, or null when no price is configured for the model (never 0 for unknown). */ estimatedCostUsd: string | null; costNote: string | null };
}

export interface VoiceTurnView {
  turnId: string;
  runId: string | null;
  userTranscript: string;
  assistantSpoken: string;
  assistantCanonical: string | null;
  interrupted: boolean;
  createdAt: string;
}
