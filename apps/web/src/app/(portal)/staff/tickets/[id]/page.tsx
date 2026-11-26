"use client";

import { useParams } from "next/navigation";
import { TicketDetailView } from "@/features/tickets/components/ticket-detail";

export default function StaffTicket() {
  return <TicketDetailView id={useParams<{ id: string }>().id} backHref="/staff/tickets" />;
}
