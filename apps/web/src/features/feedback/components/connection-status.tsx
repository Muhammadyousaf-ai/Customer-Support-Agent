"use client";

import { WifiOff } from "lucide-react";
import { useConnectionStore } from "@/features/chat/store/connection.store";

/** Visible only when the live stream is not healthy. The agent keeps working server-side while we reconnect. */
export function ConnectionStatus() {
  const status = useConnectionStore((s) => s.status);
  if (status === "connected" || status === "connecting") return null;
  return (
    <div role="status" data-testid="connection-status" data-state={status} className="flex items-center gap-2 border-b border-rule bg-surface px-6 py-2 text-sm text-muted-foreground">
      <WifiOff aria-hidden className="size-4 shrink-0" />
      <span>
        {status === "reconnecting" ? "Reconnecting to the support agent. Your conversation is saved." : "Disconnected from live updates."} Previously completed actions will not be repeated.
      </span>
    </div>
  );
}
