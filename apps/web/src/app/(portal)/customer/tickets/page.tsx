"use client";

import { Button } from "@/components/ui/button";
import Link from "next/link";
import { PageTitle } from "@/features/portal/components/bits";
import { NewTicketDialog } from "@/features/tickets/components/new-ticket-dialog";
import { TicketList } from "@/features/tickets/components/ticket-list";

export default function CustomerTickets() {
  return (
    <>
      <PageTitle title="My tickets" subtitle="Requests the AI assistant passed to our team, and ones you opened yourself." action={<div className="flex gap-2"><Button asChild variant="outline"><Link href="/support">Ask the AI assistant</Link></Button><NewTicketDialog /></div>} />
      <TicketList base="/customer/tickets" emptyText="You have no tickets yet." />
    </>
  );
}
