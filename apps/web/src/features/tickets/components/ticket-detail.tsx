"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TICKET_PRIORITIES, type TicketDetail, type TicketPriority, type TicketStatus } from "@support-ai/contracts";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { authed, useAuthStore } from "@/features/auth/auth.store";
import { ApiError } from "@/features/chat/services/api.client";
import { label } from "./ticket-list";

interface StaffOption { id: string; displayName: string; status: string }
const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong.");

function Composer({ placeholder, cta, onSend, testId }: { placeholder: string; cta: string; onSend: (body: string) => Promise<unknown>; testId: string }) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try { await onSend(body.trim()); setBody(""); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-2">
      <Textarea aria-label={placeholder} placeholder={placeholder} rows={3} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} data-testid={testId} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button size="sm" onClick={send} loading={busy} disabled={!body.trim()}>{cta}</Button>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="space-y-3"><h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>{children}</section>
);

/** One ticket for any role. What is shown and which actions appear follow the payload the API returned for this caller. */
export function TicketDetailView({ id, backHref }: { id: string; backHref: string }) {
  const user = useAuthStore((s) => s.user)!;
  const qc = useQueryClient();
  const key = ["tickets", "detail", id];
  const { data: t, error, isLoading } = useQuery({ queryKey: key, queryFn: () => authed<TicketDetail>(`/tickets/${id}`), refetchInterval: 8_000 });
  const staff = useQuery({ queryKey: ["admin", "staff"], queryFn: () => authed<StaffOption[]>("/admin/staff"), enabled: user.role === "admin" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolution, setResolution] = useState("");

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: ["tickets"] })]);
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: async () => { setActionError(null); await refresh(); },
    onError: (e) => setActionError(errText(e)),
  });
  const post = (path: string, body?: unknown) => () => authed(`/tickets/${id}${path}`, { method: "POST", body });

  if (error) return <div role="alert" className="space-y-2"><p className="text-sm text-destructive">{error instanceof ApiError && error.status === 404 ? "This ticket does not exist or you do not have access to it." : errText(error)}</p><Link className="text-sm text-primary" href={backHref}>Back to tickets</Link></div>;
  if (isLoading || !t) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const isStaffSide = user.role !== "customer";
  const mine = t.assignedStaff?.id === user.id;
  const canWork = user.role === "admin" || mine;
  const open = t.status !== "closed";
  const canReply = open && (user.role === "customer" || canWork);
  const canClaim = isStaffSide && !t.assignedStaff && t.status === "open";
  const nextStates = canWork ? t.allowedTransitions.filter((s) => s !== "resolved") : [];
  const workStates = nextStates.filter((s) => s !== "open");
  const canReturn = nextStates.includes("open");
  const canResolve = canWork && t.allowedTransitions.includes("resolved");

  return (
    <article className="space-y-8" data-testid="ticket-detail">
      <div>
        <Link className="text-sm text-primary" href={backHref}>← Tickets</Link>
        <h1 className="mt-2 text-2xl font-semibold text-ink">{t.subject}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.id} · {label(t.category)} · opened {new Date(t.createdAt).toLocaleString()}{t.source !== "manual" ? " · escalated by the AI assistant" : ""}</p>
        <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
          <div><dt className="text-muted-foreground">Status</dt><dd className="font-medium text-ink" data-testid="ticket-status">{label(t.status)}</dd></div>
          <div><dt className="text-muted-foreground">Priority</dt><dd className="font-medium text-ink">{label(t.priority)}</dd></div>
          <div><dt className="text-muted-foreground">Assigned to</dt><dd className="font-medium text-ink">{t.assignedStaff?.displayName ?? "Unassigned"}</dd></div>
          {isStaffSide && <div><dt className="text-muted-foreground">Customer</dt><dd className="font-medium text-ink">{t.customer?.displayName ?? "Hidden until claimed"}</dd></div>}
        </dl>
      </div>

      {(canClaim || nextStates.length > 0 || canResolve || user.role === "admin" || (user.role === "customer" && open && t.status !== "resolved")) && (
        <Section title="Actions">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-4 rounded-lg border border-rule bg-surface p-4">
            {canClaim && <Button onClick={() => act.mutate(post("/claim"))} data-testid="claim">Claim ticket</Button>}
            {workStates.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Status</p>
                <Select key={t.status} onValueChange={(v) => act.mutate(post("/status", { status: v }))}>
                  <SelectTrigger aria-label="Change status" className="w-52" data-testid="status-select"><SelectValue placeholder={label(t.status)} /></SelectTrigger>
                  <SelectContent>{workStates.map((s) => <SelectItem key={s} value={s}>{label(s)}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
            {user.role === "admin" && (
              <>
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">Assigned to</p>
                  <Select onValueChange={(v) => act.mutate(post("/assign", { staffId: v === "none" ? null : v }))}>
                    <SelectTrigger aria-label="Assign to staff" className="w-52"><SelectValue placeholder={t.assignedStaff?.displayName ?? "Unassigned"} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Unassigned</SelectItem>
                      {(staff.data ?? []).filter((s) => s.status === "active").map((s) => <SelectItem key={s.id} value={s.id}>{s.displayName}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">Priority</p>
                  <Select value={t.priority} onValueChange={(v) => act.mutate(post("/priority", { priority: v as TicketPriority }))}>
                    <SelectTrigger aria-label="Priority" className="w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>{TICKET_PRIORITIES.map((p) => <SelectItem key={p} value={p}>{label(p)}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </>
            )}
            <div className="ml-auto flex items-center gap-2">
              {canReturn && <Button variant="outline" onClick={() => act.mutate(post("/status", { status: "open" }))}>Return to queue</Button>}
              {canResolve && <Button onClick={() => setResolving(true)} data-testid="resolve">Resolve…</Button>}
              {user.role === "customer" && open && t.status !== "resolved" && <Button variant="outline" onClick={() => act.mutate(post("/withdraw"), { onSuccess: () => toast.success("Request withdrawn"), onError: (e) => toast.error(errText(e)) })}>Withdraw request</Button>}
            </div>
          </div>
          {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
        </Section>
      )}

      {t.aiSummary && isStaffSide && <Section title="AI summary"><p className="whitespace-pre-wrap text-sm text-body">{t.aiSummary}</p></Section>}
      {t.description && <Section title="Request"><p className="whitespace-pre-wrap text-sm text-body">{t.description}</p></Section>}
      {t.resolution && <Section title="Resolution"><p className="whitespace-pre-wrap text-sm text-body">{t.resolution}</p></Section>}

      <Section title="Conversation">
        <ol className="space-y-3" data-testid="ticket-messages">
          {t.messages.length === 0 && <li className="text-sm text-muted-foreground">{isStaffSide && !canWork ? "Claim the ticket to read the conversation." : "No messages yet."}</li>}
          {t.messages.map((m) => (
            <li key={m.id} className="rounded-lg border border-rule p-3">
              <p className="text-xs text-muted-foreground">{m.authorName ?? label(m.authorKind)} · {label(m.authorKind)} · {new Date(m.createdAt).toLocaleString()}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{m.body}</p>
            </li>
          ))}
        </ol>
        {canReply && <Composer testId="reply-box" placeholder={user.role === "customer" ? "Write a message to support" : "Reply to the customer"} cta="Send reply" onSend={async (body) => { await authed(`/tickets/${id}/messages`, { method: "POST", body: { body } }); await refresh(); }} />}
      </Section>

      {t.notes && (
        <Section title="Internal notes (never shown to the customer)">
          <ol className="space-y-3" data-testid="ticket-notes">
            {t.notes.length === 0 && <li className="text-sm text-muted-foreground">No notes yet.</li>}
            {t.notes.map((n) => <li key={n.id} className="rounded-lg border border-dashed border-rule p-3"><p className="text-xs text-muted-foreground">{n.authorName} · {new Date(n.createdAt).toLocaleString()}</p><p className="mt-1 whitespace-pre-wrap text-sm text-ink">{n.body}</p></li>)}
          </ol>
          {canWork && <Composer testId="note-box" placeholder="Add an internal note" cta="Add note" onSend={async (body) => { await authed(`/tickets/${id}/notes`, { method: "POST", body: { body } }); await refresh(); }} />}
        </Section>
      )}

      {t.transcript && t.transcript.length > 0 && (
        <Section title="AI conversation before escalation">
          <ol className="space-y-2 text-sm">{t.transcript.map((m, i) => <li key={i}><span className="text-muted-foreground">{m.author}:</span> <span className="whitespace-pre-wrap text-body">{m.content}</span></li>)}</ol>
        </Section>
      )}

      <Section title="History">
        <ol className="space-y-1 text-sm text-body">
          {t.history.map((h, i) => <li key={i}>{new Date(h.at).toLocaleString()} · {h.from ? `${label(h.from)} → ` : ""}{label(h.to)}{h.by ? ` · ${h.by}` : ""}{h.note ? ` · ${h.note}` : ""}</li>)}
        </ol>
        {t.assignments && t.assignments.length > 0 && <ol className="space-y-1 text-sm text-muted-foreground">{t.assignments.map((a, i) => <li key={i}>{new Date(a.at).toLocaleString()} · {a.staff ?? "Unassigned"} ({a.method.replace(/_/g, " ")}{a.by ? ` by ${a.by}` : ""})</li>)}</ol>}
      </Section>

      <Dialog open={resolving} onOpenChange={setResolving}>
        <DialogContent>
          <DialogHeader><DialogTitle>Resolve ticket</DialogTitle><DialogDescription>Describe what was done. The customer sees this, and the conversation returns to the AI assistant.</DialogDescription></DialogHeader>
          <Textarea aria-label="Resolution" rows={5} value={resolution} maxLength={2000} onChange={(e) => setResolution(e.target.value)} data-testid="resolution-box" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolving(false)}>Cancel</Button>
            <Button disabled={!resolution.trim()} onClick={async () => { await act.mutateAsync(post("/resolve", { resolution: resolution.trim() })); setResolving(false); setResolution(""); }} data-testid="confirm-resolve">Resolve</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}
