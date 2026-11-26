import type { Env } from "../config/env.js";

export const VOICE_CONFIG = Symbol("VOICE_CONFIG");

export interface VoiceConfig {
  provider: "openai" | "fake";
  apiKey: string;
  model: string;
  voice: string;
  /** Input transcription model (OpenAI Realtime only). */
  transcriptionModel: string;
  /** OpenAI semantic VAD eagerness (low waits longest before ending a turn). */
  vadEagerness: "low" | "medium" | "high" | "auto";
  maxSessionMs: number;
  maxReconnectAttempts: number;
  inputSampleRate: number;
  outputSampleRate: number;
  chunkDurationMs: number;
  ticketTtlMs: number;
  providerSetupTimeoutMs: number;
  idleTimeoutMs: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
  maxInputBytesPerSec: number;
  maxBufferedBytes: number;
  toolTimeoutMs: number;
}

export function resolveVoiceConfig(env: Env): VoiceConfig {
  const provider = env.VOICE_PROVIDER ?? "openai";
  if (provider === "fake" && env.NODE_ENV === "production") throw new Error("VOICE_PROVIDER=fake is a development test double and cannot run in production");
  return {
    provider, apiKey: env.OPENAI_API_KEY, model: env.OPENAI_REALTIME_MODEL, voice: env.OPENAI_REALTIME_VOICE,
    transcriptionModel: env.OPENAI_TRANSCRIBE_MODEL, vadEagerness: env.OPENAI_VAD_EAGERNESS,
    maxSessionMs: env.VOICE_MAX_SESSION_MINUTES * 60_000, maxReconnectAttempts: env.VOICE_MAX_RECONNECT_ATTEMPTS,
    inputSampleRate: env.VOICE_INPUT_SAMPLE_RATE, outputSampleRate: env.VOICE_OUTPUT_SAMPLE_RATE, chunkDurationMs: env.VOICE_CHUNK_DURATION_MS,
    ticketTtlMs: env.VOICE_TICKET_TTL_MS, providerSetupTimeoutMs: env.VOICE_PROVIDER_SETUP_TIMEOUT_MS, idleTimeoutMs: env.VOICE_IDLE_TIMEOUT_MS,
    reconnectBaseDelayMs: env.VOICE_RECONNECT_BASE_DELAY_MS, reconnectMaxDelayMs: env.VOICE_RECONNECT_MAX_DELAY_MS,
    maxInputBytesPerSec: env.VOICE_MAX_INPUT_BYTES_PER_SEC, maxBufferedBytes: env.VOICE_MAX_BUFFERED_BYTES, toolTimeoutMs: env.VOICE_TOOL_TIMEOUT_MS,
  };
}
