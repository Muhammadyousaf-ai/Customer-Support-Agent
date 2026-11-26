import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface StoredConversation {
  id: string;
  /** Per-conversation bearer token. Stored on this device only; the server keeps just a hash. */
  token: string;
  createdAt: string;
}

interface ConversationsState {
  items: StoredConversation[];
  activeId: string | null;
  add: (c: StoredConversation) => void;
  /** Adds without changing the selection (used when pulling an account's conversations onto this device). */
  addQuiet: (c: StoredConversation) => void;
  remove: (id: string) => void;
  setToken: (id: string, token: string) => void;
  /** Keeps only these ids (the server's list for a signed-in account). */
  retain: (ids: Set<string>) => void;
  setActive: (id: string | null) => void;
}

/**
 * Which conversations this browser holds and which one is selected. This is the only thing kept in browser storage:
 * messages, runs and transactions always come from the backend, which is the source of truth. For a signed-in customer
 * the list itself is the server's (`GET /me/sessions`); this store then only caches per-conversation tokens.
 */
export const useConversationsStore = create<ConversationsState>()(
  persist(
    (set) => ({
      items: [],
      activeId: null,
      add: (c) => set((s) => ({ items: [c, ...s.items.filter((x) => x.id !== c.id)], activeId: c.id })),
      addQuiet: (c) => set((s) => (s.items.some((x) => x.id === c.id) ? s : { items: [...s.items, c].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) })),
      remove: (id) => set((s) => { const items = s.items.filter((x) => x.id !== id); return { items, activeId: s.activeId === id ? (items[0]?.id ?? null) : s.activeId }; }),
      setToken: (id, token) => set((s) => ({ items: s.items.map((x) => (x.id === id ? { ...x, token } : x)) })),
      retain: (ids) => set((s) => { const items = s.items.filter((x) => ids.has(x.id)); return { items, activeId: s.activeId && ids.has(s.activeId) ? s.activeId : (items[0]?.id ?? null) }; }),
      setActive: (activeId) => set({ activeId }),
    }),
    { name: "support-ai:conversations", storage: createJSONStorage(() => localStorage), skipHydration: true },
  ),
);
