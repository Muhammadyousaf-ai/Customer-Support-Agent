"use client";

import { useMemo } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { Span, SpanCategory } from "../../types";
import { useObservabilityStore } from "../../store/observability.store";
import { ms } from "../../format";
import { CATEGORY_LABEL, WaterfallChart, layoutRows } from "./waterfall-chart";
import { SpanDetails } from "./span-details";

export function ExecutionTimeline({ spans, restricted }: { spans: Span[]; restricted: boolean }) {
  const { selectedSpanId, selectSpan, hiddenCategories, toggleCategory } = useObservabilityStore();
  const visible = useMemo(() => spans.filter((s) => !hiddenCategories.includes(s.category)), [spans, hiddenCategories]);
  // Children of a hidden span are re-parented to the root so a filter never hides what you asked to see.
  const ids = new Set(visible.map((s) => s.spanId));
  const rows = useMemo(() => layoutRows(visible.map((s) => (s.parentSpanId && !ids.has(s.parentSpanId) ? { ...s, parentSpanId: null } : s))), [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = Math.max(1, ...spans.map((s) => s.startOffsetMs + s.durationMs));
  const selected = spans.find((s) => s.spanId === selectedSpanId) ?? null;
  const cats = [...new Set(spans.map((s) => s.category))] as SpanCategory[];
  if (!spans.length) return <p className="text-sm text-faint">No spans recorded for this run yet.</p>;
  return (
    <div className="space-y-3" data-testid="timeline">
      <p className="text-xs text-faint">Timeline spans {ms(total)}. Nested spans overlap their parents, so their durations are not added together.</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1" role="group" aria-label="Filter by operation type">
        {cats.map((c) => (
          <div key={c} className="flex items-center gap-1.5">
            <Checkbox id={`cat-${c}`} data-testid={`filter-${c}`} checked={!hiddenCategories.includes(c)} onCheckedChange={() => toggleCategory(c)} />
            <Label htmlFor={`cat-${c}`} className="text-xs font-normal text-ink">{CATEGORY_LABEL[c]}</Label>
          </div>
        ))}
      </div>
      <WaterfallChart rows={rows} totalMs={total} selectedId={selectedSpanId} onSelect={selectSpan} />
      {selected ? <SpanDetails span={selected} restricted={restricted} /> : <p className="text-xs text-faint">Select an operation to inspect it.</p>}
    </div>
  );
}
