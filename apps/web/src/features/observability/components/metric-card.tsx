export function MetricCard({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId?: string }) {
  return (
    <div className="rounded-lg border border-rule bg-background p-3" data-testid={testId}>
      <p className="text-xs text-faint">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-ink" data-testid={testId ? `${testId}-value` : undefined}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-faint">{hint}</p>}
    </div>
  );
}

export function Restricted({ what }: { what: string }) {
  return <p className="rounded-md border border-dashed border-rule p-3 text-xs text-faint" data-testid="restricted">{what} is restricted. Enter the administrator key above to inspect it.</p>;
}

export function Pre({ children, testId }: { children: string; testId?: string }) {
  return <pre data-testid={testId} className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-wash p-3 font-mono text-xs leading-relaxed text-ink">{children}</pre>;
}
