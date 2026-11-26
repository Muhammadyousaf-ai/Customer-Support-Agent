"use client";

import { Send, Square } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { RunStatus } from "../types";

const MAX = 4000;

const PLACEHOLDER: Partial<Record<RunStatus, string>> = {
  awaiting_input: "Type your answer…",
  awaiting_confirmation: "Use the card above, or type yes / no",
  processing: "The agent is working…",
  streaming: "The agent is replying…",
};

interface Props {
  runStatus: RunStatus;
  submitting: boolean;
  disabled?: boolean;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
}

/** Behaviour follows the run state: Stop while the agent works, free input when it needs the customer. */
export function MessageComposer({ runStatus, submitting, disabled, onSend, onStop }: Props) {
  const [draft, setDraft] = useState("");
  const working = runStatus === "processing" || runStatus === "streaming";

  const submit = async () => {
    const text = draft.trim();
    if (!text || submitting || working || disabled) return;
    setDraft(""); // cleared immediately; a failed send is retried from the message itself, not from the draft
    await onSend(text);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="border-t border-rule bg-background px-4 py-3 sm:px-6">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <Textarea
          aria-label="Message"
          data-testid="composer-input"
          value={draft}
          maxLength={MAX}
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          disabled={disabled}
          placeholder={PLACEHOLDER[runStatus] ?? "Ask about your subscription, refunds or technical issues"}
          className="max-h-40 min-h-11 resize-none"
        />
        {working ? (
          <Button type="button" variant="outline" size="icon-lg" aria-label="Stop" data-testid="stop-button" onClick={onStop}>
            <Square />
          </Button>
        ) : (
          <Button type="button" size="icon-lg" aria-label="Send" data-testid="send-button" onClick={() => void submit()} disabled={!draft.trim() || submitting || disabled}>
            <Send />
          </Button>
        )}
      </div>
      {draft.length > MAX - 200 && <p className="mx-auto mt-1 max-w-3xl text-right text-xs text-faint">{MAX - draft.length} characters left</p>}
    </div>
  );
}
