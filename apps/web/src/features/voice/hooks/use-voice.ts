"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { VoiceController } from "../services/voice-controller";
import { useVoiceStore, voiceStoreApi } from "../store/voice.store";

/** One controller per open conversation. Leaving the conversation (or the page) ends voice and releases the microphone. */
export function useVoice(conversation: { id: string; token: string }) {
  const qc = useQueryClient();
  const controller = useRef<VoiceController | null>(null);
  const { id, token } = conversation;

  const get = useCallback(() => {
    controller.current ??= new VoiceController({
      conversation: { id, token },
      store: voiceStoreApi(),
      onActivity: () => {
        void qc.invalidateQueries({ queryKey: ["messages", id] });
        void qc.invalidateQueries({ queryKey: ["session", id] });
      },
    });
    return controller.current;
  }, [id, token, qc]);

  useEffect(() => {
    return () => {
      const c = controller.current;
      controller.current = null;
      if (c?.isActive) void c.end();
      useVoiceStore.getState().reset();
    };
  }, [id]);

  const state = useVoiceStore();
  return {
    state,
    active: state.connectionStatus !== "disconnected",
    start: () => get().start(),
    end: () => get().end(),
    setMuted: (m: boolean) => get().setMuted(m),
    setPushToTalk: (v: boolean) => get().setPushToTalk(v),
    holdToTalk: (held: boolean) => get().holdToTalk(held),
    interrupt: () => get().interrupt(),
    /** Returns the analyser for what the customer should currently see (their voice, or the assistant's). */
    analyser: (): AnalyserNode | null => {
      const c = controller.current;
      if (!c) return null;
      return useVoiceStore.getState().activity === "assistant_speaking" ? c.outputAnalyser : c.micAnalyser;
    },
  };
}
