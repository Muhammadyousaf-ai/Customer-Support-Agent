import type { Candidate } from "../../types";

/** One bar per candidate; the marker is the similarity threshold. Similarity alone does not prove an answer is correct. */
export function SimilarityChart({ accepted, rejected, threshold }: { accepted: Candidate[]; rejected: Candidate[]; threshold: number }) {
  const rows = [...accepted.map((c) => ({ ...c, ok: true })), ...rejected.map((c) => ({ ...c, ok: false }))];
  return (
    <ul className="space-y-1.5" data-testid="similarity-chart">
      {rows.map((c) => (
        <li key={`${c.chunkId}-${c.ok}`} className="text-xs" data-testid="candidate" data-accepted={c.ok}>
          <div className="flex justify-between gap-2"><span className="truncate text-ink">{c.heading || c.document}</span><span className="tabular-nums text-faint">{c.similarity.toFixed(2)} · {c.ok ? "kept" : "rejected"}</span></div>
          <div className="relative mt-0.5 h-2 rounded-sm bg-surface">
            <div className={`h-full rounded-sm ${c.ok ? "bg-body" : "bg-divider"}`} style={{ width: `${Math.max(1, Math.min(100, c.similarity * 100))}%` }} />
            <div className="absolute top-[-2px] h-3 w-px bg-ink" style={{ left: `${threshold * 100}%` }} title={`Threshold ${threshold}`} />
          </div>
        </li>
      ))}
    </ul>
  );
}
