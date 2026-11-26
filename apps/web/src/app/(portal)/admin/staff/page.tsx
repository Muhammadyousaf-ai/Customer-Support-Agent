"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field } from "@/features/auth/components/field";
import { authed } from "@/features/auth/auth.store";
import { ApiError } from "@/features/chat/services/api.client";
import { PageTitle } from "@/features/portal/components/bits";
import { label } from "@/features/tickets/components/ticket-list";

interface Staff { id: string; email: string; displayName: string; status: string; available: boolean; activeTickets: number; resolvedTickets: number }

export default function AdminStaff() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "staff"], queryFn: () => authed<Staff[]>("/admin/staff") });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ displayName: "", email: "" });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin"] });
  const invite = useMutation({
    mutationFn: () => authed("/admin/staff", { method: "POST", body: f }),
    onSuccess: async () => { setOpen(false); setF({ displayName: "", email: "" }); setError(null); await refresh(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : "Could not invite."),
  });
  const act = useMutation({
    mutationFn: (p: string) => authed(p, { method: "POST" }),
    onSuccess: (_v, p) => { toast.success(p.endsWith("/suspend") ? "Staff member suspended" : p.endsWith("/activate") ? "Staff member reactivated" : "Invitation sent again"); return refresh(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not update the staff member."),
  });
  const setAvail = useMutation({ mutationFn: (v: { id: string; available: boolean }) => authed(`/admin/staff/${v.id}/availability`, { method: "POST", body: { available: v.available } }), onSuccess: refresh });
  return (
    <>
      <PageTitle title="Staff" subtitle="Staff accounts are invited, never self-registered. They set their own password from a one-time link." action={
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button data-testid="invite-staff">Invite staff member</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Invite staff member</DialogTitle><DialogDescription>They receive a link valid for 7 days.</DialogDescription></DialogHeader>
            <div className="space-y-3">
              <Field id="s-name" label="Name" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />
              <Field id="s-email" label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button loading={invite.isPending} disabled={!f.displayName.trim() || !f.email.trim()} onClick={() => invite.mutate()}>Send invitation</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      } />
      <div className="overflow-x-auto rounded-lg border border-rule">
        <table className="w-full text-left text-sm" data-testid="staff-table">
          <thead className="border-b border-rule text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Account</th><th className="px-3 py-2">Active</th><th className="px-3 py-2">Resolved</th><th className="px-3 py-2">Auto-assign</th><th className="px-3 py-2 text-right">Actions</th></tr></thead>
          <tbody>
            {(data ?? []).map((s) => (
              <tr key={s.id} className="border-b border-rule last:border-0">
                <td className="px-3 py-2"><div className="font-medium text-ink">{s.displayName}</div><div className="text-xs text-muted-foreground">{s.email}</div></td>
                <td className="px-3 py-2 text-body">{label(s.status)}</td>
                <td className="px-3 py-2">{s.activeTickets}</td><td className="px-3 py-2">{s.resolvedTickets}</td>
                <td className="px-3 py-2">{s.status === "active" ? <Button size="sm" variant="ghost" onClick={() => setAvail.mutate({ id: s.id, available: !s.available })}>{s.available ? "Available" : "Away"}</Button> : "–"}</td>
                <td className="px-3 py-2 text-right space-x-1">
                  {s.status === "invited" && <Button size="sm" variant="outline" onClick={() => act.mutate(`/admin/staff/${s.id}/resend-invite`)}>Resend invite</Button>}
                  {s.status === "active" && <Button size="sm" variant="outline" onClick={() => act.mutate(`/admin/users/${s.id}/suspend`)}>Suspend</Button>}
                  {s.status === "suspended" && <Button size="sm" variant="outline" onClick={() => act.mutate(`/admin/users/${s.id}/activate`)}>Reactivate</Button>}
                </td>
              </tr>
            ))}
            {data?.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No staff yet. Invite the first one.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
