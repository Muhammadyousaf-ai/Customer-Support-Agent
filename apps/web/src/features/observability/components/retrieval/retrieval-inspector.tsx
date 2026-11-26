import type { Retrieval } from "../../types";
import { json, ms } from "../../format";
import { Pre } from "../metric-card";
import { SimilarityChart } from "./similarity-chart";

export function RetrievalInspector({ retrievals }: { retrievals: Retrieval[] }) {
  if (!retrievals.length) return <p className="text-sm text-faint">No knowledge-base retrieval in this run.</p>;
  return (
    <div className="space-y-3" data-testid="retrieval-inspector">
      {retrievals.map((r) => (
        <section key={r.attempt} className="space-y-2 rounded-lg border border-rule bg-background p-3" data-testid="retrieval-attempt">
          <header className="flex justify-between gap-2"><h4 className="text-sm font-semibold text-ink">Attempt {r.attempt}</h4><span className="text-xs tabular-nums text-faint">{ms(r.durationMs)}</span></header>
          <p className="text-xs text-ink">Query: <span className="font-medium">{r.query}</span></p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt className="text-faint">Threshold</dt><dd className="tabular-nums text-ink">{r.threshold}</dd>
            <dt className="text-faint">Top-K</dt><dd className="text-ink">{r.topK}</dd>
            <dt className="text-faint">Embedding model</dt><dd className="text-ink">{r.embedding?.embeddingModel ?? "n/a"}</dd>
            <dt className="text-faint">Filters</dt><dd className="text-ink">{Object.keys(r.filters).length ? Object.entries(r.filters).map(([k, v]) => `${k}: ${String(v)}`).join(" · ") : "none"}</dd>
            <dt className="text-faint">Evidence verification</dt><dd className="text-ink" data-testid="evidence-outcome">{r.evidenceVerified ? "Passed" : `Not passed${r.verification?.reason ? `: ${r.verification.reason}` : ""}`}</dd>
            <dt className="text-faint">Outcome</dt><dd className="text-ink">{r.status}{r.escalationReason ? ` — ${r.escalationReason}` : ""}</dd>
          </dl>
          <SimilarityChart accepted={r.accepted} rejected={r.rejected} threshold={r.threshold} />
          <p className="text-xs text-faint">{r.stages.map((s) => `${s.name.replace("rag.", "").replace("guardrail.", "")} ${ms(s.durationMs)}`).join(" · ")}</p>
          {r.accepted[0]?.policyVersion && <p className="text-xs text-faint">Policy version {r.accepted[0].policyVersion}</p>}
          <details><summary className="cursor-pointer text-xs text-faint">Raw</summary><Pre>{json(r)}</Pre></details>
        </section>
      ))}
    </div>
  );
}
