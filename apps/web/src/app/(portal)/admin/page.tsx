"use client";

import { useQuery } from "@tanstack/react-query";
import { TICKET_STATUSES } from "@support-ai/contracts";
import { authed } from "@/features/auth/auth.store";
import { minutes, PageTitle, Stat } from "@/features/portal/components/bits";
import { label } from "@/features/tickets/components/ticket-list";

interface Overview {
  tickets: { total: number; byStatus: Record<string, number>; unassigned: number; openByPriority: Record<string, number>; resolutionRate: number | null; avgResolutionMinutes: number; avgFirstResponseMinutes: number };
  ai: { runs7d: number; escalations7d: number; escalationRate: number | null; budget: { spentUsd?: number; limitUsd?: number } | null };
  users: Record<string, number>;
  staff: Array<{ id: string; displayName: string; status: string; available: boolean; activeTickets: number; resolvedTickets: number; maxActiveTickets: number }>;
}
const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);

export default function AdminOverview() {
  const { data: d, error } = useQuery({ queryKey: ["admin", "overview"], queryFn: () => authed<Overview>("/admin/overview"), refetchInterval: 20_000 });
  if (error) return <p role="alert" className="text-sm text-destructive">Could not load the overview.</p>;
  if (!d) return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <>
      <PageTitle title="Overview" subtitle="Tickets, staff workload and AI escalations across the system." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat testId="stat-total" label="Tickets" value={d.tickets.total} />
        <Stat label="Unassigned" value={d.tickets.unassigned} hint="Open, waiting for an owner" />
        <Stat label="Resolution rate" value={pct(d.tickets.resolutionRate)} />
        <Stat label="Avg resolution" value={minutes(d.tickets.avgResolutionMinutes)} hint={`First response ${minutes(d.tickets.avgFirstResponseMinutes)}`} />
        <Stat label="AI runs (7 days)" value={d.ai.runs7d} />
        <Stat label="Escalations (7 days)" value={d.ai.escalations7d} hint={`${pct(d.ai.escalationRate)} of runs`} />
        <Stat label="Customers" value={d.users.customer ?? 0} />
        <Stat label="Staff" value={d.users.staff ?? 0} />
      </div>
      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Tickets by status</h2>
          <table className="w-full text-sm"><tbody>{TICKET_STATUSES.map((s) => <tr key={s} className="border-b border-rule"><td className="py-2 text-body">{label(s)}</td><td className="py-2 text-right font-medium text-ink">{d.tickets.byStatus[s] ?? 0}</td></tr>)}</tbody></table>
        </section>
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Staff workload</h2>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1">Name</th><th>Active</th><th>Resolved</th><th>Availability</th></tr></thead>
            <tbody>{d.staff.map((s) => <tr key={s.id} className="border-b border-rule"><td className="py-2 text-ink">{s.displayName}</td><td>{s.activeTickets} / {s.maxActiveTickets}</td><td>{s.resolvedTickets}</td><td className="text-body">{s.status !== "active" ? label(s.status) : s.available ? "Available" : "Away"}</td></tr>)}{d.staff.length === 0 && <tr><td colSpan={4} className="py-4 text-muted-foreground">No staff yet.</td></tr>}</tbody>
          </table>
        </section>
      </div>
    </>
  );
}
