"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { API_URL } from "../services/api.client";
import { getSession } from "../services/session.service";
import { createEventStream } from "../services/streaming.service";
import { useChatStore } from "../store/chat.store";
import { useConnectionStore } from "../store/connection.store";

const REFRESH_ON = new Set(["response.completed", "run.paused", "run.completed", "run.failed", "run.cancelled", "clarification.required"]);

/**
 * Owns the live connection for one conversation: restores state from the REST session view, then streams events
 * into the Zustand store. Reconnects automatically, resuming from the last applied sequence.
 */
export function useEventStream(conversation: { id: string; token: string } | null, onUnauthorized?: () => void) {
  const qc = useQueryClient();

  const id = conversation?.id;
  const token = conversation?.token;

  useEffect(() => {
    if (!id || !token) return;
    useChatStore.getState().reset();
    let cancelled = false;

    // Refresh recovery: the session view tells us immediately about a running or paused run and its pending action.
    getSession(id, token)
      .then((view) => !cancelled && useChatStore.getState().hydrate(view))
      .catch(() => undefined);

    const stream = createEventStream({
      url: `${API_URL}/sessions/${id}/events`,
      token,
      getLastSequence: () => useChatStore.getState().events.lastSequence,
      onStatus: (s) => useConnectionStore.getState().setStatus(s),
      onUnauthorized,
      onEvent: (e) => {
        const before = useChatStore.getState().events.lastSequence;
        useChatStore.getState().applyEvent(e);
        if (e.sequence > before && REFRESH_ON.has(e.type)) {
          void qc.invalidateQueries({ queryKey: ["messages", id] });
          void qc.invalidateQueries({ queryKey: ["session", id] });
        }
      },
    });
    return () => {
      cancelled = true;
      stream.close();
    };
  }, [id, token, qc, onUnauthorized]);
}
