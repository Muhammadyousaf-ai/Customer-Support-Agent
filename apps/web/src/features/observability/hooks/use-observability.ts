"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useChatStore } from "@/features/chat/store/chat.store";
import { getRunHistory, getRunTraces, getVoiceDiagnostics } from "../services/observability.service";
import { loadAdminKey, useObservabilityStore } from "../store/observability.store";

const LIVE = new Set(["running", "executing_tool"]);

/**
 * History and the selected run's full trace for the open conversation. It updates live without a new transport: every
 * event on the existing chat SSE stream (tool started, response, run finished...) triggers a throttled refetch of the
 * persisted trace, and an active run is also polled. A dropped stream therefore loses nothing: the data is in PostgreSQL.
 */
export function useObservability(conversation: { id: string; token: string } | null) {
  const qc = useQueryClient();
  const { selectedRunId, adminKey } = useObservabilityStore();
  const activeRunId = useChatStore((s) => s.events.activeRunId);
  const lastSequence = useChatStore((s) => s.events.lastSequence);
  useEffect(() => loadAdminKey(), []);

  const auth = conversation ? { token: conversation.token, adminKey: adminKey || undefined } : null;
  const history = useQuery({
    queryKey: ["obs", "history", conversation?.id, adminKey],
    queryFn: () => getRunHistory(conversation!.id, auth!),
    enabled: Boolean(conversation), refetchOnWindowFocus: false,
  });
  const runId = selectedRunId ?? activeRunId ?? history.data?.[0]?.runId ?? null;

  const traces = useQuery({
    queryKey: ["obs", "traces", runId, adminKey],
    queryFn: () => getRunTraces(runId!, auth!),
    enabled: Boolean(conversation && runId), placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data && !LIVE.has(q.state.data.overview.status) ? false : 1500),
  });

  const voiceId = traces.data?.overview.voice?.voiceSessionId ?? null;
  const voice = useQuery({ queryKey: ["obs", "voice", voiceId, adminKey], queryFn: () => getVoiceDiagnostics(voiceId!, auth!), enabled: Boolean(conversation && voiceId), refetchInterval: 3000 });

  // Live updates from the shared SSE stream, throttled to one refetch per 500 ms.
  const last = useRef(0);
  useEffect(() => {
    if (!conversation || !lastSequence) return;
    const wait = Math.max(0, 500 - (Date.now() - last.current));
    const t = setTimeout(() => {
      last.current = Date.now();
      void qc.invalidateQueries({ queryKey: ["obs"] });
    }, wait);
    return () => clearTimeout(t);
  }, [lastSequence, conversation, qc]);

  return { history, traces, voice, runId, following: selectedRunId === null };
}
