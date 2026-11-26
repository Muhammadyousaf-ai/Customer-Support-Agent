import type { ProviderEvent, ProviderFunctionCall, ProviderUsage } from "../live-provider.js";

/** The subset of OpenAI Realtime server events the adapter reads. Both GA (`response.output_audio.*`) and beta (`response.audio.*`) names are accepted. */
export interface RealtimeServerEvent {
  type: string;
  delta?: string;
  transcript?: string;
  session?: { id?: string };
  error?: { code?: string; message?: string };
  response?: {
    status?: string;
    output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_token_details?: { audio_tokens?: number };
      output_token_details?: { audio_tokens?: number };
    };
  };
}

const parseArgs = (s: string | undefined): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(s ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export function normalizeRealtimeUsage(u: NonNullable<NonNullable<RealtimeServerEvent["response"]>["usage"]>): ProviderUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    audioInputTokens: u.input_token_details?.audio_tokens ?? 0,
    audioOutputTokens: u.output_token_details?.audio_tokens ?? 0,
  };
}

/**
 * Maps one Realtime event to provider-neutral events. Function calls are read from `response.done` (one place, no
 * duplicates from the streaming argument events) and emitted before `turnComplete`, in the order the
 * orchestrator expects.
 */
export function normalizeRealtimeEvent(ev: RealtimeServerEvent): ProviderEvent[] {
  switch (ev.type) {
    case "session.updated":
      return [{ type: "ready", ...(ev.session?.id ? { providerSessionId: ev.session.id } : {}) }];
    case "input_audio_buffer.speech_started":
      return [{ type: "interrupted" }];
    case "response.output_audio.delta":
    case "response.audio.delta":
      return ev.delta ? [{ type: "audio", pcm: Buffer.from(ev.delta, "base64") }] : [];
    case "response.output_audio_transcript.delta":
    case "response.audio_transcript.delta":
      return ev.delta ? [{ type: "outputTranscript", text: ev.delta }] : [];
    case "conversation.item.input_audio_transcription.completed":
      return ev.transcript ? [{ type: "inputTranscript", text: ev.transcript }] : [];
    case "response.done": {
      const out: ProviderEvent[] = [];
      const calls: ProviderFunctionCall[] = (ev.response?.output ?? [])
        .filter((o) => o.type === "function_call" && o.call_id && o.name)
        .map((o) => ({ id: o.call_id!, name: o.name!, args: parseArgs(o.arguments) }));
      if (calls.length) out.push({ type: "toolCall", calls });
      if (ev.response?.usage) out.push({ type: "usage", usage: normalizeRealtimeUsage(ev.response.usage) });
      out.push({ type: "generationComplete" }, { type: "turnComplete" });
      return out;
    }
    default:
      return [];
  }
}
