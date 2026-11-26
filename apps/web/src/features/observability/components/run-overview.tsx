import type { Overview } from "../types";
import { ms, tokens, usd } from "../format";
import { MetricCard } from "./metric-card";

export function RunOverview({ o }: { o: Overview }) {
  const m = o.metrics;
  const u = o.usage;
  return (
    <div className="space-y-3" data-testid="run-overview">
      <div className="grid grid-cols-2 gap-2">
        <MetricCard testId="m-latency" label="End-to-end processing" value={ms(m.endToEndProcessingMs)} hint={m.customerWaitMs > 0 ? `plus ${ms(m.customerWaitMs)} waiting for the customer` : "Sum of execution segments"} />
        <MetricCard testId="m-ttft" label="First visible answer text" value={ms(m.userVisibleTtftMs)} hint={`Model first-token time: ${m.modelTtftMs === null ? "not observable (non-streaming)" : ms(m.modelTtftMs)}`} />
        <MetricCard testId="m-tokens" label="Total tokens" value={tokens(u.totalTokens)} hint={`${tokens(u.inputTokens)} input · ${tokens(u.outputTokens)} output`} />
        <MetricCard testId="m-cost" label="Estimated API cost" value={usd(u.estimatedCostUsd)} hint={u.costComplete ? `${u.modelCalls} model calls` : u.costNotes[0] ?? "Some calls have no configured price"} />
        <MetricCard testId="m-tools" label="Tool executions" value={String(m.toolCalls)} hint={`${m.toolCalls - m.toolFailures} succeeded · ${m.toolFailures} failed · ${m.retries} retries`} />
        <MetricCard testId="m-retrieval" label="Retrieval similarity" value={o.grounding?.topSimilarity != null ? o.grounding.topSimilarity.toFixed(2) : "n/a"} hint={o.grounding ? (o.grounding.evidenceVerified ? "Evidence verified" : "Evidence not verified") : "No retrieval in this run"} />
        <MetricCard label="Time to first status" value={ms(m.timeToFirstStatusMs)} hint="Request to first visible activity" />
        <MetricCard label="Model calls" value={String(m.modelCalls)} hint={`${ms(m.modelMs)} in the model`} />
        {m.timeToFirstAudioMs !== undefined && <MetricCard testId="m-audio" label="Time to first audio" value={ms(m.timeToFirstAudioMs)} hint="Speech end to first audio sent" />}
      </div>
      <p className="text-xs text-faint">Trace <span className="font-mono">{o.traceId ?? "n/a"}</span> · {m.segments} execution segment{m.segments === 1 ? "" : "s"} · {m.guardrailFailures} guardrail rejection{m.guardrailFailures === 1 ? "" : "s"}</p>
      {o.observability.degraded && <p className="text-xs text-ink" role="status" data-testid="obs-degraded">Observability is degraded: some telemetry could not be stored ({o.observability.dropped} dropped). The support workflow is unaffected.</p>}
    </div>
  );
}
