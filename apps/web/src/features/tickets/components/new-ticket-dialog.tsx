"use client";

import { useQueryClient } from "@tanstack/react-query";
import { TICKET_CATEGORIES, TICKET_PRIORITIES } from "@support-ai/contracts";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { authed } from "@/features/auth/auth.store";
import { ApiError } from "@/features/chat/services/api.client";
import { label } from "./ticket-list";

/** Lets a customer ask for a person directly, without going through the AI assistant first. */
export function NewTicketDialog() {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ subject: "", description: "", category: "other", priority: "normal" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await authed<{ id: string }>("/tickets", { method: "POST", body: f });
      await qc.invalidateQueries({ queryKey: ["tickets"] });
      setOpen(false);
      router.push(`/customer/tickets/${t.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not create the ticket.");
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button data-testid="new-ticket">Contact a person</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Contact our team</DialogTitle><DialogDescription>A support agent will pick this up. The AI assistant stays out of this conversation until it is resolved.</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label htmlFor="nt-subject">Subject</Label><Input id="nt-subject" maxLength={120} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></div>
          <div className="space-y-1.5"><Label htmlFor="nt-desc">What happened?</Label><Textarea id="nt-desc" rows={5} maxLength={4000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
          <div className="flex gap-3">
            <Select value={f.category} onValueChange={(v) => setF({ ...f, category: v })}><SelectTrigger aria-label="Category" className="flex-1"><SelectValue /></SelectTrigger><SelectContent>{TICKET_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{label(c)}</SelectItem>)}</SelectContent></Select>
            <Select value={f.priority} onValueChange={(v) => setF({ ...f, priority: v })}><SelectTrigger aria-label="Priority" className="flex-1"><SelectValue /></SelectTrigger><SelectContent>{TICKET_PRIORITIES.map((c) => <SelectItem key={c} value={c}>{label(c)}</SelectItem>)}</SelectContent></Select>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={submit} loading={busy} disabled={f.subject.trim().length < 3 || !f.description.trim()}>Send</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
