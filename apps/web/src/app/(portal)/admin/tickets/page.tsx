"use client";

import { PageTitle } from "@/features/portal/components/bits";
import { TicketList } from "@/features/tickets/components/ticket-list";

export default function AdminTickets() {
  return (
    <>
      <PageTitle title="Tickets" subtitle="Every ticket in the system. Assign, reassign, change priority or step in." />
      <TicketList base="/admin/tickets" scopes={[{ value: "all", label: "All" }, { value: "unassigned", label: "Unassigned" }]} />
    </>
  );
}
