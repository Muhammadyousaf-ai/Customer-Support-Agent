import type { ToolRecord } from "../../types";
import { json, ms } from "../../format";
import { Pre, Restricted } from "../metric-card";

export function ToolInspector({ tools }: { tools: ToolRecord[] }) {
  if (!tools.length) return <p className="text-sm text-faint">No tool executions in this run.</p>;
  return (
    <ul className="space-y-2" data-testid="tool-inspector">
      {tools.map((t) => (
        <li key={t.executionId} className="rounded-lg border border-rule bg-background p-3" data-testid="tool-record" data-tool={t.tool}>
          <details>
            <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2 text-sm text-ink">
              <span className="font-mono">{t.tool}</span>
              <span className="text-xs text-faint">{t.status === "success" ? "Completed" : t.errorKind === "business_rule" ? `Rejected by policy (${t.errorCode})` : `Failed (${t.errorCode})`} · {ms(t.durationMs)}</span>
            </summary>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt className="text-faint">Type</dt><dd className="text-ink">{t.type ?? "n/a"}</dd>
              <dt className="text-faint">Attempts</dt><dd className="text-ink">{t.attempts} ({t.retries} retries)</dd>
              <dt className="text-faint">Transaction</dt><dd className="text-ink" data-testid="tool-committed">{t.type === "write" ? (t.committed ? "Committed" : "Not committed") : "Read only"}</dd>
              <dt className="text-faint">Chosen by model call</dt><dd className="font-mono text-ink">{t.parentModelInvocation ?? "n/a"}</dd>
              <dt className="text-faint">Execution id</dt><dd className="truncate font-mono text-ink">{t.executionId}</dd>
            </dl>
            {t.restricted ? <div className="mt-2"><Restricted what="Tool arguments and results" /></div> : (
              <div className="mt-2 space-y-2"><Pre testId="tool-args">{json(t.args)}</Pre><Pre testId="tool-result">{json(t.result)}</Pre></div>
            )}
          </details>
        </li>
      ))}
    </ul>
  );
}
