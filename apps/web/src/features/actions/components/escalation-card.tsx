import { LifeBuoy } from "lucide-react";
import { titleCase } from "@/features/chat/format";
import type { EscalationTicket } from "@/features/chat/types";

export function EscalationCard({ ticket }: { ticket: EscalationTicket }) {
  return (
    <section aria-label="Support escalation" data-testid="escalation-card" className="my-3 rounded-2xl border border-divider bg-card p-5 shadow-card">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink"><LifeBuoy aria-hidden className="size-4" /> Support escalation</h3>
      <p data-testid="ticket-id" className="mt-2 text-2xl font-semibold tracking-tight text-ink">{ticket.ticketId}</p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Reason</dt><dd className="text-ink">{titleCase(ticket.reason)}</dd>
        <dt className="text-muted-foreground">Priority</dt><dd className="text-ink">{titleCase(ticket.priority)}</dd>
        <dt className="text-muted-foreground">Status</dt><dd className="text-ink">{titleCase(ticket.status)}</dd>
      </dl>
    </section>
  );
}
