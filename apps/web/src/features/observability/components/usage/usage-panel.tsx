import type { UsageInfo } from "../../types";
import { tokens, usd } from "../../format";
import { MetricCard } from "../metric-card";

export function UsagePanel({ u }: { u: UsageInfo }) {
  const t = u.totals;
  return (
    <div className="space-y-3" data-testid="usage-panel">
      <div className="grid grid-cols-2 gap-2">
        <MetricCard testId="u-cost" label="Estimated API cost" value={usd(t.estimatedCostUsd)} hint={t.costComplete ? undefined : `Partial: ${usd(t.partialCostUsd)} priced so far`} />
        <MetricCard label="Total tokens" value={tokens(t.totalTokens)} hint={`${t.modelCalls} model calls`} />
      </div>
      <table className="w-full text-xs" data-testid="usage-table">
        <thead><tr className="text-left text-faint"><th className="py-1 font-normal">Model</th><th className="font-normal">Calls</th><th className="text-right font-normal">In</th><th className="text-right font-normal">Out</th><th className="text-right font-normal">Cost</th></tr></thead>
        <tbody>
          {u.models.map((m) => (
            <tr key={m.model} className="border-t border-rule" data-testid="usage-row">
              <td className="py-1 font-mono text-ink">{m.model}</td><td className="tabular-nums">{m.calls}</td>
              <td className="text-right tabular-nums">{tokens(m.inputTextTokens + m.cachedInputTokens)}</td><td className="text-right tabular-nums">{tokens(m.outputTextTokens)}</td><td className="text-right tabular-nums">{usd(m.costUsd)}</td>
            </tr>
          ))}
          {u.embedding.tokens > 0 && (
            <tr className="border-t border-rule"><td className="py-1 font-mono text-ink">{u.embedding.model ?? "embedding"}</td><td>query</td><td className="text-right tabular-nums">{tokens(u.embedding.tokens)}</td><td className="text-right">–</td>
              <td className="text-right tabular-nums">{u.embedding.cost && "usd" in u.embedding.cost ? `$${u.embedding.cost.usd.toFixed(6)}` : "Unavailable"}</td></tr>
          )}
        </tbody>
      </table>
      {t.costNotes.map((n) => <p key={n} className="text-xs text-faint">{n}</p>)}
      {t.pricingVersions.length > 0 && <p className="text-xs text-faint">Pricing used: {t.pricingVersions.join(", ")}</p>}
      <p className="text-xs text-faint">{t.label}</p>
    </div>
  );
}
