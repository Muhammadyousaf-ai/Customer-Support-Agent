/** Shapes returned by /v1/observability/*. All costs are fixed-precision USD strings; null means "unavailable", never zero. */
export type SpanCategory = "agent" | "llm" | "tool" | "rag" | "guardrail" | "voice" | "db";

export interface RunSummary {
  runId: string; mode: "chat" | "voice"; status: string; startedAt: string; finishedAt: string | null; request: string | null;
  processingMs: number; modelCalls: number; toolCalls: number; tokens: number; estimatedCostUsd: string | null; costComplete: boolean;
}

export interface Span {
  spanId: string; traceId: string; parentSpanId: string | null; name: string; category: SpanCategory; startOffsetMs: number; startedAt: string; durationMs: number;
  status: "ok" | "error"; errorCode: string | null; attributes: Record<string, unknown>; detail?: unknown;
}

export interface ModelInvocation {
  invocationId: string; index: number; spanId: string | null; purpose: string; provider: string; model: string; promptVersion: string | null; durationMs: number;
  finishReason: string | null; status: string; errorCode: string | null; usageSource: "provider_reported" | "estimated" | "unavailable";
  usage: { inputTextTokens: number; outputTextTokens: number; cachedInputTokens: number; thinkingTokens: number; totalTokens: number };
  estimatedCostUsd: string | null; costStatus: "ok" | "unavailable"; costNote: string | null; pricingVersion: string | null;
  restricted?: boolean; systemPrompt?: string | null; messages?: unknown; tools?: Array<{ name: string; description: string }>; output?: unknown;
}

export interface ToolRecord {
  executionId: string; tool: string; type: string | null; status: "success" | "failed"; attempts: number; retries: number; durationMs: number; errorCode: string | null;
  errorKind: string | null; committed: boolean; parentModelInvocation: string | null; restricted?: boolean; args?: unknown; result?: unknown;
}

export interface Candidate { chunkId: string; document: string; heading: string; policyVersion?: string; similarity: number }
export interface Retrieval {
  attempt: number; durationMs: number; query: string; topK: number; threshold: number; status: string; evidenceVerified: boolean; confidenceScore: number;
  filters: Record<string, unknown>; embedding?: { embeddingModel?: string; embeddings?: string }; verification?: { method?: string; supported?: boolean; reason?: string };
  accepted: Candidate[]; rejected: Candidate[]; stages: Array<{ name: string; durationMs: number }>; escalationReason?: string;
}

export interface GuardrailInfo { results: Array<{ sequence: number; event: string; guardrail: string; status: string; reasonCode: string | null; action: string | null }>; nodes: Array<{ node: string; durationMs: number; status: string }> }

export interface UsageInfo {
  models: Array<{ model: string; calls: number; inputTextTokens: number; outputTextTokens: number; cachedInputTokens: number; thinkingTokens: number; totalTokens: number; costUsd: string | null; sources: string[] }>;
  embedding: { tokens: number; model: string | null; cost: { usd: number } | { unavailable: string } | null };
  totals: { inputTokens: number; outputTokens: number; totalTokens: number; embeddingTokens: number; modelCalls: number; estimatedCostUsd: string | null; partialCostUsd: string; costComplete: boolean; costNotes: string[]; pricingVersions: string[]; label: string };
}

export interface ErrorsInfo {
  errors: Array<{ category: string; kind: string; code: string | null; message: string | null; at: string }>;
  retries: Array<{ tool: string; attempts: number; finalErrorCode: string | null; recovered: boolean }>;
  summary: { infrastructure: number; businessRule: number; guardrail: number };
}

export interface Overview {
  runId: string; mode: "chat" | "voice"; status: string; provider: string; traceId: string | null;
  metrics: {
    endToEndProcessingMs: number; wallClockMs: number; customerWaitMs: number; segments: number; timeToFirstStatusMs: number | null; userVisibleTtftMs: number | null; modelTtftMs: number | null;
    modelCalls: number; modelMs: number; toolCalls: number; toolFailures: number; retries: number; retrievalAttempts: number; guardrailFailures: number; timeToFirstAudioMs?: number | null;
  };
  usage: UsageInfo["totals"]; grounding: { topSimilarity: number | null; evidenceVerified: boolean | null } | null; voice: { voiceSessionId: string } | null;
  observability: { degraded: boolean; dropped: number; queued: number };
}

export interface Traces { access: "admin" | "owner"; overview: Overview; spans: Span[]; models: ModelInvocation[]; tools: ToolRecord[]; retrievals: Retrieval[]; guardrails: GuardrailInfo; usage: UsageInfo; errors: ErrorsInfo }

export interface VoiceDiagnostics {
  voiceSessionId: string; status: string | null; model: string | null; endReason: string | null;
  metrics: { connectionSetupMs?: number | null; timeToFirstAudioMs?: number | null; interruptionLatencyMs?: number | null; rttMs?: number | null; timeToFirstPlaybackMs?: number | null; droppedFrames?: number; reconnectAttempts?: number; interruptions?: number; audioInputBytes?: number; audioOutputBytes?: number; staleAudioDropped?: number };
  cost: { estimatedCostUsd: string | null; pricingVersion: string | null; attribution: string } | null; audioSeconds: { input: number; output: number } | null;
  turns: Array<{ turnId: string; runId: string | null; interrupted: boolean; grounding: string; firstAudioMs: number | null }>;
  functionCalls: { total: number; duplicates: number }; events: Array<{ name: string; at: string; durationMs: number; status: string; attributes: Record<string, unknown> }>;
}
