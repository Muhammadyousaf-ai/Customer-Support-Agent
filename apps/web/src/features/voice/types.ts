import type { VoiceError } from "@support-ai/contracts";

export type VoiceConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "failed";
export type VoiceActivity = "idle" | "listening" | "user_speaking" | "processing" | "assistant_speaking";

export interface TranscriptEntry {
  turnId: string;
  role: "user" | "assistant";
  text: string;
  interrupted?: boolean;
}

/** Connection, conversation and microphone state are separate on purpose (see Phase 6 section 19). */
export interface VoiceState {
  sessionId: string | null;
  voiceSessionId: string | null;
  connectionStatus: VoiceConnectionStatus;
  activity: VoiceActivity;
  isMuted: boolean;
  pushToTalk: boolean;
  activeTurnId: string | null;
  activeRunId: string | null;
  /** Audio belonging to an older generation is rejected at the player. */
  audioGenerationId: number;
  partialUserTranscript: string;
  partialAssistantTranscript: string;
  transcript: TranscriptEntry[];
  /** Throttled copies for text/aria; the waveform reads the analysers directly, never React state. */
  microphoneLevel: number;
  outputAudioLevel: number;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  error: VoiceError | { code: "PERMISSION_DENIED" | "NO_DEVICE" | "UNSUPPORTED" | "CLIENT"; message: string; recoverable: boolean } | null;
  /** Why voice ended when the server or the limits ended it (shown as a plain note, then chat continues). */
  notice: string | null;
}
