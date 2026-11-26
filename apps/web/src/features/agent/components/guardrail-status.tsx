import { ShieldCheck, ShieldAlert } from "lucide-react";
import { titleCase } from "@/features/chat/format";
import type { GuardrailResult } from "@/features/chat/types";

/** Compact grounding status: which checks the answer passed, and any that rejected a draft. */
export function GuardrailStatus({ guardrails }: { guardrails: GuardrailResult[] }) {
  if (guardrails.length === 0) return null;
  const failed = guardrails.filter((g) => !g.passed);
  return (
    <p data-testid="guardrail-status" className="my-1 flex items-start gap-2 text-xs text-muted-foreground">
      {failed.length ? <ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" /> : <ShieldCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" />}
      <span>
        {failed.length
          ? `Checks flagged: ${failed.map((g) => titleCase(g.guardrail)).join(", ")}${failed.some((g) => g.action === "retry") ? " (revising the answer)" : ""}`
          : `Answer verified: ${guardrails.map((g) => titleCase(g.guardrail)).join(", ")}`}
      </span>
    </p>
  );
}
