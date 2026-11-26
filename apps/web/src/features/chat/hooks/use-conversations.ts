"use client";

import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/ui/sonner";
import { useAuthStore } from "@/features/auth/auth.store";
import { ApiError } from "../services/api.client";
import { createSession, deleteOwnSession, getOwnSession, getSession, listOwnSessions, mintSessionToken, renameOwnSession, renameSession } from "../services/session.service";
import { useConversationsStore } from "../store/conversations.store";

/**
 * Conversation list. Signed-in customers: the server's list is the truth (GET /me/sessions), and summaries, rename and delete
 * use the account token, so they never depend on a per-conversation token this browser may have lost. Anonymous demo
 * visitors fall back to the conversations this browser holds tokens for.
 */
export function useConversations() {
  const qc = useQueryClient();
  const { items, activeId, add, remove, setActive } = useConversationsStore();
  const [ready, setReady] = useState(false);

  // Rehydrate from localStorage after mount (avoids server/client markup mismatch).
  useEffect(() => {
    void Promise.resolve(useConversationsStore.persist.rehydrate()).then(() => setReady(true));
  }, []);

  const signedIn = useAuthStore((s) => s.status === "authed");
  useEffect(() => {
    if (!ready || !signedIn) return;
    let cancelled = false;
    const startedAt = new Date().toISOString();
    void (async () => {
      const mine = await listOwnSessions();
      if (cancelled) return;
      const store = useConversationsStore.getState();
      // Drop what the server no longer lists (deleted elsewhere, or left over from another account); keep anything created during this sync.
      store.retain(new Set([...mine.map((s) => s.id), ...store.items.filter((x) => x.createdAt >= startedAt).map((x) => x.id)]));
      for (const s of mine) {
        if (cancelled) return;
        if (useConversationsStore.getState().items.some((x) => x.id === s.id)) continue;
        useConversationsStore.getState().addQuiet({ id: s.id, token: await mintSessionToken(s.id), createdAt: s.createdAt });
      }
    })().catch(() => undefined); // staff/admin have no account conversations; offline just skips the sync
    return () => { cancelled = true; };
  }, [ready, signedIn]);

  const summaries = useQueries({
    queries: items.map((c) => ({ queryKey: ["session", c.id], queryFn: () => (signedIn ? getOwnSession(c.id) : getSession(c.id, c.token)), staleTime: 5_000, retry: false })),
  });

  const create = useMutation({
    mutationFn: createSession,
    onSuccess: (s) => {
      // A brand-new session has no history: seed it so the chat shows the empty state at once instead of a skeleton flash.
      qc.setQueryData(["messages", s.sessionId], []);
      add({ id: s.sessionId, token: s.sessionToken, createdAt: new Date().toISOString() });
    },
  });

  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => {
      if (signedIn) return renameOwnSession(id, title);
      const c = items.find((x) => x.id === id);
      if (!c) throw new Error("Unknown conversation");
      return renameSession(id, c.token, title);
    },
    onSuccess: (view, { id }) => qc.setQueryData(["session", id], view),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      if (!signedIn) return;
      try {
        await deleteOwnSession(id);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e; // already gone on the server: just drop it here too
      }
    },
    onSuccess: (_v, id) => {
      remove(id);
      qc.removeQueries({ queryKey: ["session", id] });
      qc.removeQueries({ queryKey: ["messages", id] });
      toast.success("Conversation deleted");
    },
    onError: () => toast.error("Could not delete the conversation. Please try again."),
  });

  // The open conversation's token was rejected (rotated on another device). An owner just gets a fresh one, once.
  const recovering = useRef(new Set<string>());
  const recover = useCallback(
    (id: string) => {
      if (!signedIn || recovering.current.has(id)) return remove(id);
      recovering.current.add(id);
      mintSessionToken(id)
        .then((token) => useConversationsStore.getState().setToken(id, token))
        .catch(() => remove(id))
        .finally(() => setTimeout(() => recovering.current.delete(id), 10_000));
    },
    [signedIn, remove],
  );

  const conversations = items.map((c, i) => ({ ...c, view: summaries[i]?.data ?? null, unavailable: summaries[i]?.isError ?? false }));
  const active = conversations.find((c) => c.id === activeId) ?? null;
  return { ready, conversations, active, activeId, create, rename, select: setActive, remove: (id: string) => del.mutate(id), recover };
}
