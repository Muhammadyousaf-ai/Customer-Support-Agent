"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { authed, refreshAccess, useAuthStore } from "@/features/auth/auth.store";
import { API_URL } from "@/features/chat/services/api.client";
import { SseParser } from "@/features/chat/services/sse-parser";

export interface NotificationItem { id: number; kind: string; title: string; body: string | null; ticketId: string | null; createdAt: string; read: boolean }
interface NotificationList { unread: number; items: NotificationItem[] }

/** Notifications are persisted server-side; the SSE stream only tells us to refetch. Polling is the fallback if the stream drops. */
export function useNotifications() {
  const qc = useQueryClient();
  const token = useAuthStore((s) => s.accessToken);
  const query = useQuery({ queryKey: ["notifications"], queryFn: () => authed<NotificationList>("/me/notifications"), refetchInterval: 30_000 });

  useEffect(() => {
    if (!token) return;
    const ctl = new AbortController();
    let stopped = false;
    const run = async () => {
      while (!stopped) {
        try {
          const res = await fetch(`${API_URL}/me/events`, { headers: { authorization: `Bearer ${useAuthStore.getState().accessToken ?? token}`, accept: "text/event-stream" }, signal: ctl.signal });
          if (res.status === 401) await refreshAccess(); // expired access token: the refreshed token restarts this effect
          if (!res.ok || !res.body) throw new Error(String(res.status));
          const parser = new SseParser();
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const f of parser.push(value)) if (f.event) { void qc.invalidateQueries({ queryKey: ["notifications"] }); void qc.invalidateQueries({ queryKey: ["tickets"] }); }
          }
        } catch {
          if (ctl.signal.aborted) return;
        }
        await new Promise((r) => setTimeout(r, 5000)); // the server closes streams after a few minutes; reconnect
      }
    };
    void run();
    return () => { stopped = true; ctl.abort(); };
  }, [token, qc]);

  return query;
}
