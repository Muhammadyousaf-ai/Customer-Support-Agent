import type { VoiceEvent } from "@support-ai/contracts";
import { create } from "zustand";
import { initialVoiceState, reduceVoiceEvent } from "../services/voice-event-reducer";
import type { VoiceState } from "../types";

interface VoiceStore extends VoiceState {
  apply: (e: VoiceEvent) => void;
  patch: (p: Partial<VoiceState>) => void;
  reset: () => void;
}

/** Only serializable state lives here. AudioContexts, streams and sockets stay inside VoiceController. */
export const useVoiceStore = create<VoiceStore>((set) => ({
  ...initialVoiceState(),
  apply: (e) => set((s) => reduceVoiceEvent(s, e)),
  patch: (p) => set(p),
  reset: () => set(initialVoiceState()),
}));

export type VoiceStoreApi = Pick<ReturnType<typeof useVoiceStore.getState>, "apply" | "patch" | "reset"> & { get: () => VoiceState };
export const voiceStoreApi = (): VoiceStoreApi => ({
  get: () => useVoiceStore.getState(),
  apply: (e) => useVoiceStore.getState().apply(e),
  patch: (p) => useVoiceStore.getState().patch(p),
  reset: () => useVoiceStore.getState().reset(),
});
