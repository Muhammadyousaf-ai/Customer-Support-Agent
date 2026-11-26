/**
 * Provider-neutral view of a live speech session. The OpenAI Realtime adapter normalizes provider messages into these events,
 * so the voice orchestrator (and its tests) never depend on SDK message shapes.
 */
export interface ProviderFunctionCall { id: string; name: string; args: Record<string, unknown> }

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  audioInputTokens: number;
  audioOutputTokens: number;
}

export type ProviderEvent =
  | { type: "ready"; providerSessionId?: string }
  | { type: "audio"; pcm: Buffer }
  | { type: "inputTranscript"; text: string }
  | { type: "outputTranscript"; text: string }
  | { type: "interrupted" }
  | { type: "generationComplete" }
  | { type: "turnComplete" }
  | { type: "toolCall"; calls: ProviderFunctionCall[] }
  | { type: "toolCancellation"; ids: string[] }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "resumptionHandle"; handle: string; resumable: boolean }
  | { type: "goAway"; timeLeftMs: number }
  | { type: "closed"; reason: string; clean: boolean }
  | { type: "error"; message: string; rateLimited?: boolean };

export interface LiveSession {
  sendAudio(pcm: Buffer): void;
  /** Signals the microphone stream paused (mute) so the provider flushes buffered speech. */
  sendAudioStreamEnd(): void;
  sendToolResponse(responses: Array<{ id: string; name: string; response: Record<string, unknown> }>): void;
  /** A text user turn; used to restore context after a fresh session and to ask the model to speak approved text. */
  sendText(text: string, opts?: { turnComplete?: boolean }): void;
  close(): void;
}

export interface LiveConnectOptions {
  systemInstruction: string;
  resumptionHandle?: string;
  voice: string;
  onEvent: (e: ProviderEvent) => void;
  signal?: AbortSignal;
}

export interface LiveProvider {
  readonly name: string;
  readonly model: string;
  connect(opts: LiveConnectOptions): Promise<LiveSession>;
}

export const LIVE_PROVIDER = Symbol("LIVE_PROVIDER");
