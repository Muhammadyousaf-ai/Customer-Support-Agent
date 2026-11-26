import { AlertCircle } from "lucide-react";
import type { ChatError } from "@/features/chat/types";
import { Button } from "@/components/ui/button";
import { RetryButton } from "./retry-button";

const HEADINGS: Record<ChatError["kind"], string> = {
  network: "Connection problem",
  rate_limited: "Slow down a little",
  conflict: "The agent is still working",
  unauthorized: "Conversation unavailable",
  server: "Unable to complete request",
  unknown: "Something went wrong",
};

/** Failure states never imply an action succeeded or was repeated: retrying re-sends the same message id. */
export function ErrorMessage({ error, onRetry, onDismiss }: { error: ChatError; onRetry?: () => void; onDismiss?: () => void }) {
  return (
    <div role="alert" data-testid="error-message" className="my-3 flex items-start gap-3 rounded-xl border border-divider bg-surface p-4">
      <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-ink" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{HEADINGS[error.kind]}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{error.message}</p>
        {error.retryable && <p className="mt-1 text-xs text-faint">Retrying sends the same message again; it will not be processed twice.</p>}
        <div className="mt-3 flex gap-2">
          {error.retryable && onRetry && <RetryButton onRetry={onRetry} />}
          {onDismiss && <Button variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button>}
        </div>
      </div>
    </div>
  );
}
