import type { VoiceEvent, VoiceEventPayloads } from "@support-ai/contracts";
import type { VoiceState } from "../types";

const MAX_TRANSCRIPT = 40;

export const initialVoiceState = (): VoiceState => ({
  sessionId: null, voiceSessionId: null, connectionStatus: "disconnected", activity: "idle", isMuted: false, pushToTalk: false,
  activeTurnId: null, activeRunId: null, audioGenerationId: 1, partialUserTranscript: "", partialAssistantTranscript: "", transcript: [],
  microphoneLevel: 0, outputAudioLevel: 0, reconnectAttempts: 0, maxReconnectAttempts: 3, error: null, notice: null,
});

const payload = <K extends keyof VoiceEventPayloads>(e: VoiceEvent): VoiceEventPayloads[K] => e.payload as VoiceEventPayloads[K];

/**
 * Pure: backend voice events in, UI state out. Binary audio never passes through here. Transcript deltas carry the
 * full text so far, so a dropped or repeated event cannot corrupt a caption.
 */
export function reduceVoiceEvent(s: VoiceState, e: VoiceEvent): VoiceState {
  switch (e.type) {
    case "voice.connected":
      return { ...s, connectionStatus: "connected", activity: s.activity === "idle" || s.activity === "listening" ? "listening" : s.activity, reconnectAttempts: 0, error: null, notice: null };
    case "voice.listening":
      return { ...s, activity: s.connectionStatus === "connected" ? "listening" : s.activity, partialAssistantTranscript: "", activeRunId: null };
    case "voice.transcript.delta": {
      const p = payload<"voice.transcript.delta">(e);
      return p.role === "user"
        ? { ...s, activity: "user_speaking", activeTurnId: p.turnId, partialUserTranscript: p.text }
        : { ...s, partialAssistantTranscript: p.text };
    }
    case "voice.transcript.completed": {
      const p = payload<"voice.transcript.completed">(e);
      const entry = { turnId: p.turnId, role: p.role, text: p.text, ...(p.interrupted ? { interrupted: true } : {}) };
      const transcript = [...s.transcript.filter((t) => !(t.turnId === p.turnId && t.role === p.role)), entry].slice(-MAX_TRANSCRIPT);
      return p.role === "user" ? { ...s, transcript, partialUserTranscript: "" } : { ...s, transcript, partialAssistantTranscript: "" };
    }
    case "voice.processing": {
      const p = payload<"voice.processing">(e);
      return { ...s, activity: "processing", activeTurnId: p.turnId, activeRunId: p.runId ?? s.activeRunId };
    }
    case "voice.speaking":
      return { ...s, activity: "assistant_speaking", audioGenerationId: Math.max(s.audioGenerationId, payload<"voice.speaking">(e).generationId) };
    case "voice.interrupted": {
      const p = payload<"voice.interrupted">(e);
      return { ...s, audioGenerationId: Math.max(s.audioGenerationId, p.nextGenerationId), partialAssistantTranscript: "", activity: p.reason === "customer_barge_in" ? "user_speaking" : "listening" };
    }
    case "voice.reconnecting": {
      const p = payload<"voice.reconnecting">(e);
      return { ...s, connectionStatus: "reconnecting", reconnectAttempts: p.attempt, maxReconnectAttempts: p.maxAttempts, activity: "idle" };
    }
    case "voice.error": {
      const p = payload<"voice.error">(e);
      return { ...s, error: p, ...(p.recoverable ? {} : { connectionStatus: "failed" as const, activity: "idle" as const }) };
    }
    case "voice.disconnected": {
      const p = payload<"voice.disconnected">(e);
      return { ...s, connectionStatus: "disconnected", activity: "idle", partialUserTranscript: "", partialAssistantTranscript: "", notice: p.fallbackToChat && p.reason !== "client_end" ? noticeFor(p.reason) : null };
    }
    default:
      return s;
  }
}

const REASONS: Record<string, string> = {
  max_session_duration: "Voice ended because the session reached its time limit. Your conversation continues in chat.",
  idle_timeout: "Voice ended because it was quiet for a while. Your conversation continues in chat.",
  recovery_failed: "Voice could not be restored. Your conversation continues in chat.",
  setup_failed: "Voice is unavailable right now. You can continue in chat.",
  superseded: "Voice was opened in another tab.",
};
export const noticeFor = (reason: string): string => REASONS[reason] ?? "Voice ended. Your conversation continues in chat.";
