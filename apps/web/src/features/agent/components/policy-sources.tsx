import { BookOpen } from "lucide-react";
import { docTitle } from "@/features/chat/format";
import type { PolicySource } from "@/features/chat/types";

export function PolicySources({ sources }: { sources: PolicySource[] }) {
  if (sources.length === 0) return null;
  return (
    <section aria-label="Supporting policies" data-testid="policy-sources" className="my-2 rounded-xl border border-border-soft px-4 py-3">
      <h3 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <BookOpen aria-hidden className="size-3.5" /> Supporting policies
      </h3>
      <ul className="space-y-2">
        {sources.map((s) => (
          <li key={`${s.document}#${s.heading}`} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0">
              <span className="block truncate text-ink">{docTitle(s.document)}</span>
              <span className="block truncate text-xs text-muted-foreground">{s.heading}</span>
            </span>
            <span className="shrink-0 text-xs tabular-nums text-faint">{s.similarity.toFixed(2)} similarity</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
