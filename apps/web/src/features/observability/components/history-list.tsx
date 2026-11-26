import { Button } from "@/components/ui/button";
import type { RunSummary } from "../types";
import { clock, ms, usd } from "../format";

export function HistoryList({ runs, selectedId, onSelect }: { runs: RunSummary[]; selectedId: string | null; onSelect: (id: string) => void }) {
  if (!runs.length) return <p className="text-sm text-faint">No runs yet in this conversation.</p>;
  return (
    <ul className="space-y-1.5" data-testid="run-history">
      {runs.map((r) => (
        <li key={r.runId}>
          <Button type="button" variant="ghost" data-testid="history-run" aria-pressed={selectedId === r.runId} onClick={() => onSelect(r.runId)} className={`h-auto w-full flex-col items-stretch justify-start whitespace-normal rounded-md border p-2 text-left text-xs font-normal ${selectedId === r.runId ? "border-ink bg-wash" : "border-rule bg-background"}`}>
            <div className="flex justify-between gap-2"><span className="truncate text-ink">{r.request ?? "(no message)"}</span><span className="shrink-0 text-faint">{clock(r.startedAt)}</span></div>
            <div className="mt-0.5 text-faint">{r.mode} · {r.status.replace("_", " ")} · {ms(r.processingMs)} · {r.toolCalls} tools · {usd(r.estimatedCostUsd)}</div>
          </Button>
        </li>
      ))}
    </ul>
  );
}
