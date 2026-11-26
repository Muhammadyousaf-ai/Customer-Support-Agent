import type { SessionView, SseEnvelope } from "@support-ai/contracts";
import { create } from "zustand";
import type { ChatError, RunStatus, RunView } from "../types";
import { hydrateFromSession, initialEventState, reduceEvent, type ChatEventState } from "../services/event-reducer";

/** A message the customer just sent, shown immediately until the persisted copy arrives (matched by clientMessageId). */
export interface OptimisticMessage {
  clientMessageId: string;
  content: string;
  status: "sending" | "sent" | "failed";
  error?: ChatError;
}

interface ChatState {
  events: ChatEventState;
  optimistic: OptimisticMessage[];
  submitting: boolean;
  /** True while a confirm/decline/stop request is in flight, to prevent double actions. */
  acting: boolean;
  error: ChatError | null;

  applyEvent: (e: SseEnvelope) => void;
  hydrate: (view: Pick<SessionView, "activeRun" | "pendingAction">) => void;
  reset: () => void;
  addOptimistic: (m: OptimisticMessage) => void;
  patchOptimistic: (clientMessageId: string, patch: Partial<OptimisticMessage>) => void;
  dropOptimistic: (persistedClientIds: Set<string>) => void;
  setSubmitting: (v: boolean) => void;
  setActing: (v: boolean) => void;
  setError: (e: ChatError | null) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  events: initialEventState(),
  optimistic: [],
  submitting: false,
  acting: false,
  error: null,

  applyEvent: (e) => set((s) => ({ events: reduceEvent(s.events, e) })),
  hydrate: (view) => set((s) => ({ events: hydrateFromSession(s.events, view) })),
  reset: () => set({ events: initialEventState(), optimistic: [], submitting: false, acting: false, error: null }),
  addOptimistic: (m) => set((s) => ({ optimistic: [...s.optimistic, m] })),
  patchOptimistic: (id, patch) => set((s) => ({ optimistic: s.optimistic.map((m) => (m.clientMessageId === id ? { ...m, ...patch } : m)) })),
  dropOptimistic: (ids) => set((s) => (s.optimistic.some((m) => ids.has(m.clientMessageId)) ? { optimistic: s.optimistic.filter((m) => !ids.has(m.clientMessageId)) } : s)),
  setSubmitting: (submitting) => set({ submitting }),
  setActing: (acting) => set({ acting }),
  setError: (error) => set({ error }),
}));

export const selectActiveRun = (s: ChatState): RunView | null => (s.events.activeRunId ? (s.events.runs[s.events.activeRunId] ?? null) : null);
export const selectRunStatus = (s: ChatState): RunStatus => selectActiveRun(s)?.status ?? "idle";
