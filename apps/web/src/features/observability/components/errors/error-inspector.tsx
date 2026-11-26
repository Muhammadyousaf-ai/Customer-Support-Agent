import type { ErrorsInfo } from "../../types";

export function ErrorInspector({ e }: { e: ErrorsInfo }) {
  const none = !e.errors.length && !e.retries.length;
  return (
    <div className="space-y-3" data-testid="error-inspector">
      <p className="text-xs text-ink" data-testid="error-summary">{e.summary.infrastructure} infrastructure failure{e.summary.infrastructure === 1 ? "" : "s"} · {e.summary.businessRule} business-rule rejection{e.summary.businessRule === 1 ? "" : "s"} · {e.summary.guardrail} guardrail outcome{e.summary.guardrail === 1 ? "" : "s"}</p>
      <p className="text-xs text-faint">A correctly rejected request is the guardrails working, not a malfunction.</p>
      {none && <p className="text-sm text-faint">No errors or retries in this run.</p>}
      <ul className="space-y-1.5">
        {e.errors.map((x, i) => (
          <li key={i} className="rounded-md border border-rule bg-background p-2 text-xs" data-testid="error-item" data-kind={x.kind}>
            <div className="flex justify-between gap-2"><span className="font-medium text-ink">{x.code ?? x.category}</span><span className="text-faint">{x.kind === "business_rule" ? "Business rule" : x.kind === "guardrail" ? "Guardrail" : "Infrastructure"} · {x.category}</span></div>
            {x.message && <p className="mt-0.5 text-faint">{x.message}</p>}
          </li>
        ))}
        {e.retries.map((r, i) => <li key={`r${i}`} className="rounded-md border border-rule bg-background p-2 text-xs text-ink" data-testid="retry-item">{r.tool}: {r.attempts} attempts, {r.recovered ? "recovered" : `failed (${r.finalErrorCode})`}</li>)}
      </ul>
    </div>
  );
}
