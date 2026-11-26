"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { authed } from "@/features/auth/auth.store";
import { PageTitle } from "@/features/portal/components/bits";

interface Entry { id: number; actor: string; actorRole: string | null; actorName: string | null; action: string; entityType: string; entityId: string; previous: unknown; next: unknown; at: string }

export default function AdminAudit() {
  const [action, setAction] = useState("");
  const { data } = useQuery({ queryKey: ["admin", "audit", action], queryFn: () => authed<{ total: number; entries: Entry[] }>(`/admin/audit-logs?limit=100${action ? `&action=${encodeURIComponent(action)}` : ""}`) });
  return (
    <>
      <PageTitle title="Audit log" subtitle="Who changed what. Entries are append-only." />
      <Input aria-label="Filter by action prefix" placeholder="Action prefix, e.g. ticket. or kb." className="mb-4 w-72" value={action} onChange={(e) => setAction(e.target.value)} />
      <div className="overflow-x-auto rounded-lg border border-rule">
        <table className="w-full text-left text-sm" data-testid="audit-table">
          <thead className="border-b border-rule text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Actor</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Entity</th><th className="px-3 py-2">Change</th></tr></thead>
          <tbody>
            {(data?.entries ?? []).map((e) => (
              <tr key={e.id} className="border-b border-rule align-top last:border-0">
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{new Date(e.at).toLocaleString()}</td>
                <td className="px-3 py-2 text-body">{e.actorName ?? e.actor}{e.actorRole ? ` (${e.actorRole})` : ""}</td>
                <td className="px-3 py-2 font-medium text-ink">{e.action}</td>
                <td className="px-3 py-2 text-body">{e.entityType} <span className="text-xs text-muted-foreground">{e.entityId}</span></td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{e.next ? JSON.stringify(e.next).slice(0, 140) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{data ? `${data.entries.length} of ${data.total} entries` : ""}</p>
    </>
  );
}
