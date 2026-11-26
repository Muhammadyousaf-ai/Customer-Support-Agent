import { MessageCircleQuestion } from "lucide-react";
import { titleCase } from "@/features/chat/format";

export function ClarificationCard({ question, requiredFields }: { question: string; requiredFields: string[] }) {
  return (
    <section aria-label="More information needed" data-testid="clarification-card" className="my-3 rounded-2xl border border-dashed border-divider p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium text-ink"><MessageCircleQuestion aria-hidden className="size-4" /> More information needed</h3>
      <p className="mt-1 text-sm text-muted-foreground">{question}</p>
      {requiredFields.length > 0 && <p className="mt-2 text-xs text-faint">Needed: {requiredFields.map(titleCase).join(", ")}</p>}
    </section>
  );
}
