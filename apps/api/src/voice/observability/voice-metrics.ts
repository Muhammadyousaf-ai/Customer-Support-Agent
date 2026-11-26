import type { VoiceMetricsView } from "@support-ai/contracts";
import type { ProviderUsage } from "../providers/live-provider.js";
import type { VoiceConfig } from "../voice.config.js";
import { pricingRegistry, formatUsd, type CostEstimate } from "../../observability/pricing/pricing-registry.js";
import { normalizeUsage } from "../../observability/usage/usage-normalizer.js";
import { pcmDurationMs } from "../audio/audio-validation.js";

/** In-memory counters for one voice session. Persisted to voice_usage when the session ends. */
export class VoiceMetrics {
  private readonly startedAt: number;
  private connectedAt: number | null = null;
  private firstAudio: number[] = [];
  private interruptLatencies: number[] = [];
  private agentMs: number[] = [];
  private usage: ProviderUsage = { inputTokens: 0, outputTokens: 0, audioInputTokens: 0, audioOutputTokens: 0 };
  inputBytes = 0;
  inputFrames = 0;
  droppedFrames = 0;
  outputBytes = 0;
  toolCalls = 0;
  duplicateCalls = 0;
  reconnects = 0;
  interruptions = 0;
  staleAudioDropped = 0;
  gatedBytes = 0;
  rttMs: number | null = null;
  firstPlayback: number | null = null;
  groundingCorrections = 0;

  constructor(private readonly cfg: VoiceConfig, private readonly model = cfg.model, private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  connected(): void {
    this.connectedAt ??= this.now();
  }
  timeToFirstAudio(ms: number): void {
    this.firstAudio.push(ms);
  }
  interruptionLatency(ms: number): void {
    this.interruptLatencies.push(ms);
  }
  agentExecution(ms: number): void {
    this.agentMs.push(ms);
  }
  addUsage(u: ProviderUsage): void {
    // Provider usage metadata is cumulative for the session, so keep the latest (max) rather than summing.
    this.usage = { inputTokens: Math.max(this.usage.inputTokens, u.inputTokens), outputTokens: Math.max(this.usage.outputTokens, u.outputTokens), audioInputTokens: Math.max(this.usage.audioInputTokens, u.audioInputTokens), audioOutputTokens: Math.max(this.usage.audioOutputTokens, u.audioOutputTokens) };
  }

  /** Priced from the versioned registry for the live model; null (unavailable) when the model has no configured price. */
  estimatedCost(model: string): CostEstimate {
    const u = this.usage;
    return pricingRegistry.estimate(model, normalizeUsage({ promptTokens: u.inputTokens, outputTokens: u.outputTokens, audioInputTokens: u.audioInputTokens, audioOutputTokens: u.audioOutputTokens }, u.inputTokens || u.outputTokens ? "provider_reported" : "unavailable"));
  }

  view(voiceSessionId: string): VoiceMetricsView {
    const last = <T>(a: T[]): T | null => (a.length ? a[a.length - 1]! : null);
    return {
      voiceSessionId,
      connectionSetupMs: this.connectedAt === null ? null : this.connectedAt - this.startedAt,
      timeToFirstAudioMs: last(this.firstAudio),
      interruptionLatencyMs: last(this.interruptLatencies),
      agentExecutionMs: last(this.agentMs),
      audioInputBytes: this.inputBytes, audioInputFrames: this.inputFrames, droppedFrames: this.droppedFrames, audioOutputBytes: this.outputBytes,
      toolCalls: this.toolCalls, duplicateCalls: this.duplicateCalls, reconnectAttempts: this.reconnects, interruptions: this.interruptions, staleAudioDropped: this.staleAudioDropped,
      rttMs: this.rttMs, timeToFirstPlaybackMs: this.firstPlayback, gatedAudioBytes: this.gatedBytes, groundingCorrections: this.groundingCorrections,
      usage: { ...this.usage, estimatedCostUsd: ((c) => (c.status === "ok" ? formatUsd(c.usd) : null))(this.estimatedCost(this.model)), costNote: ((c) => (c.status === "ok" ? null : c.reason))(this.estimatedCost(this.model)) },
    };
  }

  audioSeconds() {
    return { input: pcmDurationMs(this.inputBytes, this.cfg.inputSampleRate) / 1000, output: pcmDurationMs(this.outputBytes, this.cfg.outputSampleRate) / 1000 };
  }
}
