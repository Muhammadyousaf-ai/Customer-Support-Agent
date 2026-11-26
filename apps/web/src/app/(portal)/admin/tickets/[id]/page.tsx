"use client";

import { useParams } from "next/navigation";
import { TicketDetailView } from "@/features/tickets/components/ticket-detail";

export default function AdminTicket() {
  return <TicketDetailView id={useParams<{ id: string }>().id} backHref="/admin/tickets" />;
}
