import { create } from "zustand";
import type { SpanCategory } from "../types";

export type ObsTab = "overview" | "timeline" | "prompts" | "tools" | "rag" | "guardrails" | "usage" | "voice" | "errors" | "history";

interface ObsState {
  /** null = follow the live run. */
  selectedRunId: string | null;
  tab: ObsTab;
  selectedSpanId: string | null;
  hiddenCategories: SpanCategory[];
  adminKey: string;
  select: (runId: string | null) => void;
  setTab: (t: ObsTab) => void;
  selectSpan: (id: string | null) => void;
  toggleCategory: (c: SpanCategory) => void;
  setAdminKey: (k: string) => void;
}

const KEY = "support-ai:admin-key";
const read = (): string => { try { return sessionStorage.getItem(KEY) ?? ""; } catch { return ""; } };

/** UI state only. Traces themselves are always fetched from the backend (TanStack Query). The admin key lives in sessionStorage, never localStorage. */
export const useObservabilityStore = create<ObsState>((set) => ({
  selectedRunId: null, tab: "overview", selectedSpanId: null, hiddenCategories: [], adminKey: "",
  select: (selectedRunId) => set({ selectedRunId, selectedSpanId: null }),
  setTab: (tab) => set({ tab }),
  selectSpan: (selectedSpanId) => set({ selectedSpanId }),
  toggleCategory: (c) => set((s) => ({ hiddenCategories: s.hiddenCategories.includes(c) ? s.hiddenCategories.filter((x) => x !== c) : [...s.hiddenCategories, c] })),
  setAdminKey: (adminKey) => { try { if (adminKey) sessionStorage.setItem(KEY, adminKey); else sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ } set({ adminKey }); },
}));

export const loadAdminKey = (): void => { const k = read(); if (k) useObservabilityStore.setState({ adminKey: k }); };
