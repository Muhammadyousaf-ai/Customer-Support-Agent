import { Ban, Check, Circle, Hand, Loader2, RotateCw, X } from "lucide-react";
import { toolLabel } from "@/features/chat/services/tool-labels";
import type { ToolExecution } from "@/features/chat/types";

const STATUS_TEXT: Record<ToolExecution["status"], (t: ToolExecution) => string> = {
  running: () => "Running…",
  retrying: (t) => `Retrying (attempt ${t.attempt})…`,
  completed: (t) => (t.durationMs !== undefined ? `${t.durationMs} ms` : "Completed"),
  failed: (t) => (t.errorCode ? `Failed: ${t.errorCode}` : "Failed"),
  awaiting_confirmation: () => "Awaiting your confirmation",
  cancelled: () => "Cancelled",
};

function StatusIcon({ status }: { status: ToolExecution["status"] }) {
  const cls = "size-4 shrink-0";
  switch (status) {
    case "running":
      return <Loader2 aria-hidden className={`${cls} animate-spin text-muted-foreground`} />;
    case "retrying":
      return <RotateCw aria-hidden className={`${cls} animate-spin text-muted-foreground`} />;
    case "completed":
      return <Check aria-hidden className={`${cls} text-ink`} />;
    case "failed":
      return <X aria-hidden className={`${cls} text-ink`} />;
    case "awaiting_confirmation":
      return <Hand aria-hidden className={`${cls} text-ink`} />;
    case "cancelled":
      return <Ban aria-hidden className={`${cls} text-faint`} />;
    default:
      return <Circle aria-hidden className={`${cls} text-faint`} />;
  }
}

/** One row per tool call the agent actually made. Status is conveyed by icon and plain text. */
export function ToolExecutionItem({ item }: { item: ToolExecution }) {
  const finished = item.status === "completed" || item.status === "failed";
  const label = item.tool === "confirmation" ? "Waiting for your confirmation" : toolLabel(item.tool, finished && item.status === "completed");
  return (
    <li data-testid="tool-item" data-tool={item.tool} data-status={item.status} className="flex items-center gap-3 py-1.5 text-sm">
      <StatusIcon status={item.status} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-ink">{label}</p>
        <p className="truncate font-mono text-xs text-faint">{item.tool === "confirmation" ? item.detail : item.tool}</p>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground" aria-label={`Status: ${STATUS_TEXT[item.status](item)}`}>
        {STATUS_TEXT[item.status](item)}
      </span>
    </li>
  );
}
