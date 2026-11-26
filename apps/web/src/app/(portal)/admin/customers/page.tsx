"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Input } from "@/components/ui/input";
import { authed } from "@/features/auth/auth.store";
import { PageTitle } from "@/features/portal/components/bits";
import { label } from "@/features/tickets/components/ticket-list";

interface Customer { id: string; email: string; displayName: string; status: string; createdAt: string; lastLoginAt: string | null; conversations: number; tickets: number }

export default function AdminCustomers() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const { data } = useQuery({ queryKey: ["admin", "customers", q], queryFn: () => authed<Customer[]>(`/admin/customers?q=${encodeURIComponent(q)}`) });
  const toggle = useMutation({
    mutationFn: (c: Customer) => authed(`/admin/users/${c.id}/${c.status === "suspended" ? "activate" : "suspend"}`, { method: "POST" }),
    onSuccess: (_v, c) => { toast.success(c.status === "suspended" ? `${c.displayName} reactivated` : `${c.displayName} suspended`); return qc.invalidateQueries({ queryKey: ["admin", "customers"] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not update the account."),
  });
  return (
    <>
      <PageTitle title="Customers" subtitle="Registered customer accounts." />
      <Input aria-label="Search customers" placeholder="Search name or email" className="mb-4 w-72" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="overflow-x-auto rounded-lg border border-rule">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-rule text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2">Customer</th><th className="px-3 py-2">Account</th><th className="px-3 py-2">Conversations</th><th className="px-3 py-2">Tickets</th><th className="px-3 py-2">Last sign-in</th><th className="px-3 py-2" /></tr></thead>
          <tbody>
            {(data ?? []).map((c) => (
              <tr key={c.id} className="border-b border-rule last:border-0">
                <td className="px-3 py-2"><div className="font-medium text-ink">{c.displayName}</div><div className="text-xs text-muted-foreground">{c.email}</div></td>
                <td className="px-3 py-2 text-body">{label(c.status)}</td><td className="px-3 py-2">{c.conversations}</td><td className="px-3 py-2">{c.tickets}</td>
                <td className="px-3 py-2 text-muted-foreground">{c.lastLoginAt ? new Date(c.lastLoginAt).toLocaleString() : "Never"}</td>
                <td className="px-3 py-2 text-right"><Button size="sm" variant="outline" onClick={() => toggle.mutate(c)}>{c.status === "suspended" ? "Reactivate" : "Suspend"}</Button></td>
              </tr>
            ))}
            {data?.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No customers found.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
