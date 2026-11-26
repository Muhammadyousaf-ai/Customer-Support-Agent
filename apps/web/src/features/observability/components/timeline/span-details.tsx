import type { Span } from "../../types";
import { ms, json } from "../../format";
import { Pre, Restricted } from "../metric-card";

export function SpanDetails({ span, restricted }: { span: Span; restricted: boolean }) {
  return (
    <section className="space-y-2 rounded-lg border border-rule bg-background p-3" data-testid="span-details" aria-label="Selected span">
      <h4 className="text-sm font-semibold text-ink">{span.name}</h4>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-faint">Category</dt><dd className="text-ink">{span.category}</dd>
        <dt className="text-faint">Start offset</dt><dd className="tabular-nums text-ink">{ms(span.startOffsetMs)}</dd>
        <dt className="text-faint">Duration</dt><dd className="tabular-nums text-ink" data-testid="span-duration">{ms(span.durationMs)}</dd>
        <dt className="text-faint">Status</dt><dd className="text-ink">{span.status === "ok" ? "Completed" : `Failed${span.errorCode ? ` (${span.errorCode})` : ""}`}</dd>
        {span.errorCode && span.status === "ok" && (<><dt className="text-faint">Outcome code</dt><dd className="text-ink">{span.errorCode}</dd></>)}
      </dl>
      {Object.keys(span.attributes).length > 0 && <Pre testId="span-attributes">{json(span.attributes)}</Pre>}
      {restricted ? <Restricted what="Span input and output" /> : span.detail ? <Pre testId="span-detail">{json(span.detail)}</Pre> : null}
    </section>
  );
}
