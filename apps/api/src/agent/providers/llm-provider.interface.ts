export const LLM_PROVIDER = Symbol("LLM_PROVIDER");

export type LlmRole = "system" | "user" | "assistant" | "tool";

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON string, as returned by function-calling APIs. */
  arguments: string;
  /** Opaque provider data that must be echoed back with this call (e.g. reasoning state some providers require). */
  extraContent?: unknown;
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
}

export interface LlmToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type LlmPurpose = "decision" | "evidence_check" | "summary";

export interface LlmRequest {
  purpose: LlmPurpose;
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDef[];
  toolChoice: "required" | "auto" | "none";
  signal?: AbortSignal;
}

export interface LlmResponse {
  content: string | null;
  toolCalls: LlmToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  /** False when the provider returned no usage block (the numbers above are then zeros, not measurements). */
  usageReported?: boolean;
  finishReason?: string;
  /** Subset of inputTokens served from cache. */
  cachedTokens?: number;
  /** Subset of outputTokens spent on thinking (OpenAI-compatible endpoints report it inside completion_tokens). */
  reasoningTokens?: number;
  latencyMs: number;
  model: string;
}

export const LLM_ERROR_CODES = ["LLM_TIMEOUT", "LLM_RATE_LIMIT", "LLM_UNAVAILABLE", "LLM_NOT_CONFIGURED", "LLM_INVALID_RESPONSE", "LLM_ABORTED"] as const;
export type LlmErrorCode = (typeof LLM_ERROR_CODES)[number];

export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** False when no API key is available; calls then fail with LLM_NOT_CONFIGURED. */
  readonly configured: boolean;
  complete(request: LlmRequest): Promise<LlmResponse>;
}
