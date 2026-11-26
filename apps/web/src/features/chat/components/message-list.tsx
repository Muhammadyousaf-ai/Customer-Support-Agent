"use client";

import { useEffect, useMemo, useRef } from "react";
import { AgentActivity } from "@/features/agent/components/agent-activity";
import { GuardrailStatus } from "@/features/agent/components/guardrail-status";
import { PolicySources } from "@/features/agent/components/policy-sources";
import { ClarificationCard } from "@/features/actions/components/clarification-card";
import { ConfirmationCard } from "@/features/actions/components/confirmation-card";
import { EscalationCard } from "@/features/actions/components/escalation-card";
import { RefundResultCard } from "@/features/actions/components/refund-result-card";
import type { StoredMessage } from "../services/session.service";
import { isBusy } from "../services/event-reducer";
import type { OptimisticMessage } from "../store/chat.store";
import type { RunView } from "../types";
import { MessageBubble } from "./message-bubble";
import { StreamingMessage } from "./streaming-message";

interface Props {
  messages: StoredMessage[];
  optimistic: OptimisticMessage[];
  runs: Record<string, RunView>;
  activeRun: RunView | null;
  acting: boolean;
  onConfirm: () => void;
  onDecline: () => void;
  onRetry: (clientMessageId: string, text: string) => void;
}

/** Results that belong under a finished answer: grounding, supporting policies and structured result cards. */
function RunResults({ run }: { run: RunView }) {
  return (
    <div>
      <GuardrailStatus guardrails={run.guardrails} />
      <PolicySources sources={run.sources} />
      {run.refund && <RefundResultCard refund={run.refund} />}
      {run.ticket && <EscalationCard ticket={run.ticket} />}
    </div>
  );
}

/**
 * Persisted history is the source of truth. Optimistic messages are shown only until their persisted copy arrives
 * (matched by clientMessageId), and a streamed answer is shown only until the persisted assistant message exists,
 * so nothing is ever rendered twice.
 */
export function MessageList({ messages, optimistic, runs, activeRun, acting, onConfirm, onDecline, onRetry }: Props) {
  const bottom = useRef<HTMLDivElement>(null);

  const { firstAssistant, lastAssistant, persistedIds } = useMemo(() => {
    const first = new Map<string, number>();
    const last = new Map<string, number>();
    for (const m of messages) {
      if (m.role !== "assistant" || !m.runId) continue;
      if (!first.has(m.runId)) first.set(m.runId, m.id);
      last.set(m.runId, m.id);
    }
    return { firstAssistant: first, lastAssistant: last, persistedIds: new Set(messages.map((m) => m.id)) };
  }, [messages]);

  const persistedClientIds = new Set(messages.map((m) => m.clientMessageId).filter(Boolean));
  const pendingUser = optimistic.filter((m) => !persistedClientIds.has(m.clientMessageId));
  const liveTail = activeRun && !lastAssistant.has(activeRun.runId) ? activeRun : null;
  const streamingVisible = activeRun && activeRun.streamingText && !(activeRun.messageId && persistedIds.has(activeRun.messageId));

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length, pendingUser.length, activeRun?.status, activeRun?.streamingText, activeRun?.tools.length, activeRun?.pendingAction?.id]);

  return (
    <div role="log" aria-label="Conversation" className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-6 sm:px-6">
      {messages.map((m) => {
        const run = m.runId ? runs[m.runId] : undefined;
        return (
          <div key={m.id} className="flex flex-col gap-2">
            {run && m.role === "assistant" && firstAssistant.get(m.runId!) === m.id && <AgentActivity run={run} live={activeRun?.runId === run.runId && run.status === "awaiting_confirmation"} />}
            <MessageBubble role={m.role} content={m.content} voice={m.mode === "voice"} byline={m.author === "staff" ? "Support agent" : undefined} />
            {run && m.role === "assistant" && lastAssistant.get(m.runId!) === m.id && !(run.pendingAction && activeRun?.runId === run.runId) && <RunResults run={run} />}
            {run && m.role === "assistant" && lastAssistant.get(m.runId!) === m.id && run.pendingAction && activeRun?.runId === run.runId && (
              <>
                <RunResults run={{ ...run, refund: undefined, ticket: undefined }} />
                <ConfirmationCard action={run.pendingAction} busy={acting} onConfirm={onConfirm} onDecline={onDecline} />
              </>
            )}
          </div>
        );
      })}

      {pendingUser.map((m) => (
        <MessageBubble key={m.clientMessageId} role="user" content={m.content} state={m.status === "failed" ? "failed" : "sending"} errorText={m.error?.message} onRetry={m.status === "failed" ? () => onRetry(m.clientMessageId, m.content) : undefined} />
      ))}

      {liveTail && (
        <div className="flex flex-col gap-2">
          <AgentActivity run={liveTail} live={isBusy(liveTail.status) || liveTail.status === "awaiting_confirmation"} />
          {streamingVisible && <StreamingMessage text={liveTail.streamingText} />}
          {liveTail.clarification && !liveTail.streamingText && <ClarificationCard question={liveTail.clarification.question} requiredFields={liveTail.clarification.requiredFields} />}
          <RunResults run={liveTail} />
          {liveTail.pendingAction && <ConfirmationCard action={liveTail.pendingAction} busy={acting} onConfirm={onConfirm} onDecline={onDecline} />}
        </div>
      )}
      <div ref={bottom} />
    </div>
  );
}
