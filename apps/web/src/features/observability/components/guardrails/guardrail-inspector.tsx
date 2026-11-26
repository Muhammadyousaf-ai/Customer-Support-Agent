import type { GuardrailInfo } from "../../types";
import { ms } from "../../format";

const LABEL: Record<string, string> = {
  scope: "Knowledge scope", retrieval_confidence: "Policy retrieval confidence", evidence_verification: "Evidence verification", business_validation: "Business rules", result_verification: "Response verification",
};

export function GuardrailInspector({ g }: { g: GuardrailInfo }) {
  if (!g.results.length && !g.nodes.length) return <p className="text-sm text-faint">No guardrail activity recorded for this run.</p>;
  return (
    <div className="space-y-3" data-testid="guardrail-inspector">
      <ol className="space-y-1.5">
        {g.results.map((r) => (
          <li key={r.sequence} className="rounded-md border border-rule bg-background p-2 text-xs" data-testid="guardrail-result" data-status={r.status}>
            <div className="flex justify-between gap-2"><span className="font-medium text-ink">{LABEL[r.guardrail] ?? r.guardrail}</span><span className="text-faint">{r.status === "passed" ? "Passed" : r.status === "failed" ? "Failed" : "Decision"}</span></div>
            {(r.reasonCode || r.action) && <p className="mt-0.5 text-faint">{[r.reasonCode, r.action && `action: ${r.action}`].filter(Boolean).join(" · ")}</p>}
          </li>
        ))}
      </ol>
      {g.nodes.length > 0 && <p className="text-xs text-faint">Time in guardrail steps: {g.nodes.map((n) => `${n.node.replace("_", " ")} ${ms(n.durationMs)}`).join(" · ")}</p>}
    </div>
  );
}
