"use client";

import type { useVoice } from "../hooks/use-voice";
import type { VoiceState } from "../types";
import { LiveTranscript } from "./live-transcript";
import { VoiceControls } from "./voice-controls";
import { VoiceError } from "./voice-error";
import { VoiceStatus } from "./voice-status";
import { VoiceWaveform } from "./voice-waveform";

type Voice = Omit<ReturnType<typeof useVoice>, "state"> & { state: VoiceState };

/** The voice panel docked above the composer. Chat history, confirmation cards and the composer stay fully usable. */
export function VoiceWorkspace({ voice }: { voice: Voice }) {
  const { state } = voice;
  const working = state.connectionStatus === "connecting" || state.connectionStatus === "connected" || state.connectionStatus === "reconnecting";
  if (!working && !state.error && !state.notice) return null;
  return (
    <section aria-label="Live voice" data-testid="voice-workspace" className="border-t border-rule bg-surface px-4 py-3 sm:px-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        {state.error && (
          <VoiceError
            error={state.error}
            onRetry={() => { void voice.start(); }}
            onClose={() => { void voice.end(); }}
          />
        )}
        {!state.error && state.notice && !working && <p className="text-sm text-faint" data-testid="voice-notice">{state.notice}</p>}
        {working && (
          <>
            <div className="flex items-center gap-4">
              <VoiceStatus state={state} />
              <div className="min-w-0 flex-1"><VoiceWaveform getAnalyser={voice.analyser} activity={state.activity} connection={state.connectionStatus} muted={state.isMuted} /></div>
            </div>
            <LiveTranscript entries={state.transcript} partialUser={state.partialUserTranscript} partialAssistant={state.partialAssistantTranscript} />
            <VoiceControls state={state} onMute={voice.setMuted} onEnd={() => void voice.end()} onInterrupt={voice.interrupt} onPushToTalk={voice.setPushToTalk} onHold={voice.holdToTalk} />
          </>
        )}
      </div>
    </section>
  );
}
