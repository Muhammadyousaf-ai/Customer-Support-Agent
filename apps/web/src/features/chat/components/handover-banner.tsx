"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useAuthStore } from "@/features/auth/auth.store";
import { request } from "../services/api.client";

interface Handover { mode: "AI_ACTIVE" | "WAITING_FOR_STAFF" | "HUMAN_ACTIVE"; ticket: { id: string; status: string; subject: string; assignedStaff: string | null } | null }

/**
 * Tells the customer who is answering. While a person owns the conversation the AI does not reply, so this also polls
 * for the staff member's messages (the conversation token has no push channel for them).
 */
export function HandoverBanner({ conversation }: { conversation: { id: string; token: string } }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["handover", conversation.id],
    queryFn: () => request<Handover>(`/sessions/${conversation.id}/handover`, { token: conversation.token }),
    refetchInterval: (q) => (q.state.data && q.state.data.mode !== "AI_ACTIVE" ? 4_000 : 15_000),
    retry: false,
  });
  const signedIn = useAuthStore((s) => s.status === "authed");
  const mode = data?.mode ?? "AI_ACTIVE";
  const previous = useRef(mode);
  useEffect(() => {
    // New staff messages while handed over, and one refresh when control returns to the AI.
    if (data && (mode !== "AI_ACTIVE" || previous.current !== "AI_ACTIVE")) {
      void qc.invalidateQueries({ queryKey: ["messages", conversation.id] });
    }
    previous.current = mode;
  }, [data, mode, conversation.id, qc]);

  if (mode === "AI_ACTIVE") return null;
  return (
    <div role="status" data-testid="handover-banner" data-mode={mode} className="border-b border-rule bg-surface px-6 py-2.5 text-center text-sm text-body">
      {mode === "WAITING_FOR_STAFF"
        ? "We passed this conversation to our support team. The AI assistant is paused; you can keep adding details and a person will reply here."
        : `${data?.ticket?.assignedStaff ?? "A support agent"} is handling this conversation. The AI assistant will not reply until it is resolved.`}
      {data?.ticket && signedIn && <> <a className="underline underline-offset-2" href={`/customer/tickets/${data.ticket.id}`}>View ticket</a></>}
    </div>
  );
}
