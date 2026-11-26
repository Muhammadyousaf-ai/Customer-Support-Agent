import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Span, SpanCategory } from "../../types";
import { ms } from "../../format";

/** Neutral greys only: the category is always spelled out in text, never carried by colour alone. */
const SHADE: Record<SpanCategory, string> = { agent: "bg-ink/80", llm: "bg-body", tool: "bg-faint", rag: "bg-placeholder", guardrail: "bg-divider", voice: "bg-border-soft", db: "bg-wash" };

export interface Row { span: Span; depth: number }

export function layoutRows(spans: Span[]): Row[] {
  const children = new Map<string | null, Span[]>();
  for (const s of spans) children.set(s.parentSpanId, [...(children.get(s.parentSpanId) ?? []), s]);
  const out: Row[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const s of (children.get(parent) ?? []).sort((a, b) => a.startOffsetMs - b.startOffsetMs)) {
      out.push({ span: s, depth });
      walk(s.spanId, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

interface Props { rows: Row[]; totalMs: number; selectedId: string | null; onSelect: (id: string) => void }

/** Bars are positioned by real start offset and duration. Parallel spans overlap; durations are never added up. */
export function WaterfallChart({ rows, totalMs, selectedId, onSelect }: Props) {
  return (
    <ul className="space-y-0.5" data-testid="waterfall" aria-label="Execution waterfall">
      {rows.map(({ span, depth }) => {
        const left = totalMs ? (span.startOffsetMs / totalMs) * 100 : 0;
        const width = totalMs ? Math.max(0.6, (span.durationMs / totalMs) * 100) : 1;
        return (
          <li key={span.spanId}>
            <Button
              type="button" variant="ghost" data-testid="span-row" data-span={span.name} data-category={span.category} aria-pressed={selectedId === span.spanId}
              onClick={() => onSelect(span.spanId)}
              className={cn("grid h-auto w-full grid-cols-[minmax(0,10rem)_1fr_4.5rem] items-center justify-items-stretch gap-2 rounded px-1 py-0.5 text-left text-xs font-normal hover:bg-wash", selectedId === span.spanId && "bg-wash ring-1 ring-divider")}
            >
              <span className="truncate text-ink" style={{ paddingLeft: depth * 10 }} title={span.name}>{span.name.replace(/^node\./, "")}{span.status === "error" ? " (failed)" : ""}</span>
              <span className="relative h-3.5 rounded-sm bg-surface">
                <span className={cn("absolute top-0 h-full rounded-sm", SHADE[span.category])} style={{ left: `${Math.min(left, 99.4)}%`, width: `${Math.min(width, 100 - left)}%` }} />
              </span>
              <span className="text-right tabular-nums text-faint">{ms(span.durationMs)}</span>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

export const CATEGORY_LABEL: Record<SpanCategory, string> = { agent: "Agent", llm: "Model", tool: "Tools", rag: "RAG", guardrail: "Guardrails", voice: "Voice", db: "Database" };
export const categoryShade = (c: SpanCategory) => SHADE[c];
