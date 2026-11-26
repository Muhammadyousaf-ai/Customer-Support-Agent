import type { ReactNode } from "react";

export const PageTitle = ({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) => (
  <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
    <div><h1 className="text-2xl font-semibold text-ink">{title}</h1>{subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}</div>
    {action}
  </div>
);

export const Stat = ({ label, value, hint, testId }: { label: string; value: ReactNode; hint?: string; testId?: string }) => (
  <div className="rounded-lg border border-rule p-4" data-testid={testId}>
    <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
    <p className="mt-1 text-2xl font-semibold text-ink">{value}</p>
    {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
  </div>
);

export const minutes = (m: number | null | undefined) => (!m ? "–" : m < 60 ? `${m} min` : `${(m / 60).toFixed(1)} h`);
