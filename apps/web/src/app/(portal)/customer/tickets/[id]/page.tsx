"use client";

import { useParams } from "next/navigation";
import { TicketDetailView } from "@/features/tickets/components/ticket-detail";

export default function CustomerTicket() {
  return <TicketDetailView id={useParams<{ id: string }>().id} backHref="/customer/tickets" />;
}
