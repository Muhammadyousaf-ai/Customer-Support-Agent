"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toChatError } from "../services/api.client";
import { cancelRun, resumeRun, sendMessage } from "../services/chat.service";
import { getMessages } from "../services/session.service";
import { selectActiveRun, selectRunStatus, useChatStore } from "../store/chat.store";
import { isBusy } from "../services/event-reducer";

/** Persisted history (TanStack Query) plus the actions a customer can take. Results arrive via the event stream. */
export function useChat(conversation: { id: string; token: string } | null) {
  const qc = useQueryClient();
  const run = useChatStore(selectActiveRun);
  const runStatus = useChatStore(selectRunStatus);
  const { optimistic, submitting, acting, error } = useChatStore();

  const messages = useQuery({
    queryKey: ["messages", conversation?.id],
    queryFn: () => getMessages(conversation!.id, conversation!.token),
    enabled: Boolean(conversation),
    // Resent/optimistic duplicates are reconciled by clientMessageId in the list, never by position.
    refetchOnWindowFocus: true,
  });

  const refresh = useCallback(() => {
    if (!conversation) return;
    void qc.invalidateQueries({ queryKey: ["messages", conversation.id] });
    void qc.invalidateQueries({ queryKey: ["session", conversation.id] });
  }, [conversation, qc]);

  /** Sends one logical message. A second click while a send is in flight is ignored. */
  const send = useCallback(
    async (text: string, existingClientId?: string) => {
      const store = useChatStore.getState();
      if (!conversation || store.submitting || !text.trim()) return false;
      const clientMessageId = existingClientId ?? crypto.randomUUID();
      store.setSubmitting(true);
      store.setError(null);
      if (existingClientId) store.patchOptimistic(clientMessageId, { status: "sending", error: undefined });
      else store.addOptimistic({ clientMessageId, content: text, status: "sending" });
      try {
        await sendMessage(conversation.id, conversation.token, text, clientMessageId);
        store.patchOptimistic(clientMessageId, { status: "sent" });
        refresh();
        return true;
      } catch (err) {
        const chatError = toChatError(err);
        store.patchOptimistic(clientMessageId, { status: "failed", error: chatError });
        store.setError(chatError);
        return false;
      } finally {
        useChatStore.getState().setSubmitting(false);
      }
    },
    [conversation, refresh],
  );

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    const store = useChatStore.getState();
    if (store.acting) return;
    store.setActing(true);
    store.setError(null);
    try {
      await fn();
    } catch (err) {
      store.setError(toChatError(err));
    } finally {
      useChatStore.getState().setActing(false);
    }
  }, []);

  const decide = useCallback(
    (decision: "confirm" | "decline") => {
      const runView = selectActiveRun(useChatStore.getState());
      const action = runView?.pendingAction;
      if (!conversation || !runView || !action) return Promise.resolve();
      return act(() => resumeRun(runView.runId, conversation.token, { actionId: action.id, decision }));
    },
    [conversation, act],
  );

  const stop = useCallback(() => {
    const runView = selectActiveRun(useChatStore.getState());
    if (!conversation || !runView) return Promise.resolve();
    return act(() => cancelRun(runView.runId, conversation.token));
  }, [conversation, act]);

  return {
    messages: messages.data ?? [],
    messagesLoading: messages.isLoading,
    messagesError: messages.isError,
    run,
    runStatus,
    busy: isBusy(runStatus),
    optimistic,
    submitting,
    acting,
    error,
    send,
    confirm: () => decide("confirm"),
    decline: () => decide("decline"),
    stop,
    clearError: () => useChatStore.getState().setError(null),
    refresh,
  };
}
