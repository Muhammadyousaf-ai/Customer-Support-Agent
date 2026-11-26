"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { authed } from "@/features/auth/auth.store";
import { minutes, PageTitle, Stat } from "@/features/portal/components/bits";
import { TicketList } from "@/features/tickets/components/ticket-list";

interface Stats { active: number; resolved: number; avgResolutionMinutes: number; avgFirstResponseMinutes: number; unassignedQueue: number }

export default function StaffDashboard() {
  const { data } = useQuery({ queryKey: ["tickets", "stats"], queryFn: () => authed<Stats>("/tickets/stats/me"), refetchInterval: 20_000 });
  return (
    <>
      <PageTitle title="Dashboard" subtitle="Your workload and the queue waiting for an owner." />
      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Stat testId="stat-active" label="My active tickets" value={data?.active ?? "–"} />
        <Stat label="Resolved by me" value={data?.resolved ?? "–"} />
        <Stat label="Unassigned queue" value={data?.unassignedQueue ?? "–"} hint="Waiting for someone to claim" />
        <Stat label="Avg first response" value={minutes(data?.avgFirstResponseMinutes)} />
        <Stat label="Avg resolution" value={minutes(data?.avgResolutionMinutes)} />
      </div>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Needs an owner</h2>
      <TicketList base="/staff/tickets" scopes={[{ value: "unassigned", label: "Unassigned" }]} emptyText="The queue is empty." />
      <p className="mt-4 text-sm"><Link className="text-primary" href="/staff/tickets">Open all my tickets</Link></p>
    </>
  );
}
