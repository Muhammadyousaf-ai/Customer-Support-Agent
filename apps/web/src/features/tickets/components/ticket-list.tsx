"use client";

import { useQuery } from "@tanstack/react-query";
import { TICKET_PRIORITIES, TICKET_STATUSES, type TicketSummary } from "@support-ai/contracts";
import Link from "next/link";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { authed } from "@/features/auth/auth.store";
import { useDebounced } from "@/lib/use-debounced";

export const label = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const ANY = "any";

/** Ticket table shared by all three roles; `scopes` decides which tabs a role gets (the API still enforces visibility). */
export function TicketList({ base, scopes, emptyText = "No tickets match." }: { base: string; scopes?: Array<{ value: "mine" | "unassigned" | "all"; label: string }>; emptyText?: string }) {
  const [scope, setScope] = useState(scopes?.[0]?.value);
  const [status, setStatus] = useState(ANY);
  const [priority, setPriority] = useState(ANY);
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim());
  const params = new URLSearchParams();
  if (scope) params.set("scope", scope);
  if (status !== ANY) params.set("status", status);
  if (priority !== ANY) params.set("priority", priority);
  if (term) params.set("q", term);
  const { data, isLoading, error } = useQuery({ queryKey: ["tickets", params.toString()], queryFn: () => authed<{ total: number; tickets: TicketSummary[] }>(`/tickets?${params}`), refetchInterval: 20_000, placeholderData: (prev) => prev });

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {scopes && (
          <Tabs value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
            <TabsList>{scopes.map((s) => <TabsTrigger key={s.value} value={s.value}>{s.label}</TabsTrigger>)}</TabsList>
          </Tabs>
        )}
        <Input type="search" aria-label="Search tickets" placeholder="Search subject, description or reference" className="w-72" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger aria-label="Filter by status" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ANY}>Any status</SelectItem>{TICKET_STATUSES.map((s) => <SelectItem key={s} value={s}>{label(s)}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={priority} onValueChange={setPriority}>
          <SelectTrigger aria-label="Filter by priority" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value={ANY}>Any priority</SelectItem>{TICKET_PRIORITIES.map((s) => <SelectItem key={s} value={s}>{label(s)}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">Could not load tickets.</p> : isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <div className="overflow-x-auto rounded-lg border border-rule">
          <table className="w-full text-left text-sm" data-testid="ticket-table">
            <thead className="border-b border-rule text-xs uppercase tracking-wide text-muted-foreground">
              <tr><th className="px-3 py-2">Ticket</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Priority</th><th className="px-3 py-2">Category</th><th className="px-3 py-2">Assigned to</th><th className="px-3 py-2">Updated</th></tr>
            </thead>
            <tbody>
              {(data?.tickets ?? []).map((t) => (
                <tr key={t.id} className="border-b border-rule last:border-0 hover:bg-accent/40">
                  <td className="px-3 py-2"><Link className="font-medium text-ink hover:underline" href={`${base}/${t.id}`}>{t.subject}</Link><div className="text-xs text-muted-foreground">{t.id}{t.customer?.displayName ? ` · ${t.customer.displayName}` : ""}</div></td>
                  <td className="px-3 py-2 text-body">{label(t.status)}</td>
                  <td className="px-3 py-2 text-body">{label(t.priority)}</td>
                  <td className="px-3 py-2 text-body">{label(t.category)}</td>
                  <td className="px-3 py-2 text-body">{t.assignedStaff?.displayName ?? "Unassigned"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{new Date(t.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
              {data && data.tickets.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">{term ? `No tickets match “${term}”.` : emptyText}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
