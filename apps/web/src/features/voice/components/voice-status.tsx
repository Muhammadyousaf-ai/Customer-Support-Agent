import { Loader2, Mic, MicOff, Volume2, WifiOff } from "lucide-react";
import type { VoiceState } from "../types";

export function describeVoice(s: Pick<VoiceState, "connectionStatus" | "activity" | "isMuted" | "pushToTalk" | "reconnectAttempts" | "maxReconnectAttempts">): { label: string; hint: string } {
  if (s.connectionStatus === "connecting") return { label: "Connecting", hint: "Setting up voice…" };
  if (s.connectionStatus === "reconnecting") return { label: "Reconnecting", hint: `Attempt ${s.reconnectAttempts} of ${s.maxReconnectAttempts}. Your conversation is saved.` };
  if (s.connectionStatus === "failed") return { label: "Voice unavailable", hint: "You can continue in chat." };
  if (s.connectionStatus === "disconnected") return { label: "Voice off", hint: "" };
  if (s.isMuted) return { label: "Muted", hint: "The assistant can still be heard." };
  switch (s.activity) {
    case "user_speaking": return { label: "Listening to you", hint: "" };
    case "processing": return { label: "Working on it", hint: "Checking your account and our policies." };
    case "assistant_speaking": return { label: "Assistant speaking", hint: "Speak anytime to interrupt." };
    default: return { label: s.pushToTalk ? "Hold to talk" : "Listening", hint: s.pushToTalk ? "Hold Space or the talk button." : "Go ahead, I'm listening." };
  }
}

/** Connection state and conversation state, as text (no colour-coded badges). */
export function VoiceStatus({ state }: { state: VoiceState }) {
  const { label, hint } = describeVoice(state);
  const Icon = state.connectionStatus === "connecting" ? Loader2 : state.connectionStatus === "reconnecting" || state.connectionStatus === "failed" ? WifiOff : state.isMuted ? MicOff : state.activity === "assistant_speaking" ? Volume2 : Mic;
  return (
    <div className="flex min-w-0 items-center gap-2" role="status" aria-live="polite" data-testid="voice-status" data-activity={state.activity} data-connection={state.connectionStatus}>
      <Icon aria-hidden className={`size-4 shrink-0 text-body ${state.connectionStatus === "connecting" ? "animate-spin" : ""}`} />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink">{label}</p>
        {hint && <p className="truncate text-xs text-faint">{hint}</p>}
      </div>
    </div>
  );
}
