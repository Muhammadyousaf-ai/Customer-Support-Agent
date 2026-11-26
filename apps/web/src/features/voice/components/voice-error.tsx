import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { VoiceState } from "../types";

/** Failures explain what happened and always leave chat available; the conversation is never lost. */
export function VoiceError({ error, onRetry, onClose }: { error: NonNullable<VoiceState["error"]>; onRetry: () => void; onClose: () => void }) {
  const blocked = error.code === "PERMISSION_DENIED";
  return (
    <div role="alert" data-testid="voice-error" data-code={error.code} className="flex flex-wrap items-center gap-2 rounded-lg border border-rule bg-surface px-3 py-2 text-sm text-ink">
      <AlertCircle aria-hidden className="size-4 shrink-0 text-body" />
      <span className="min-w-0 flex-1">{error.message}</span>
      {error.recoverable && !blocked && <Button size="xs" variant="outline" onClick={onRetry}>Try again</Button>}
      <Button size="xs" variant="ghost" onClick={onClose}>Continue in chat</Button>
    </div>
  );
}
