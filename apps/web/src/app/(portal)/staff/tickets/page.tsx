"use client";

import { PageTitle } from "@/features/portal/components/bits";
import { TicketList } from "@/features/tickets/components/ticket-list";

export default function StaffTickets() {
  return (
    <>
      <PageTitle title="Tickets" subtitle="Claim an unassigned ticket to read the conversation and reply." />
      <TicketList base="/staff/tickets" scopes={[{ value: "mine", label: "Mine" }, { value: "unassigned", label: "Unassigned" }]} emptyText="Nothing here." />
    </>
  );
}
