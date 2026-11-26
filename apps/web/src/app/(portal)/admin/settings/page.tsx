"use client";

import { ASSIGNMENT_MODES, type AssignmentMode } from "@support-ai/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { authed } from "@/features/auth/auth.store";
import { PageTitle } from "@/features/portal/components/bits";

interface Settings { assignmentMode: AssignmentMode; ai: Record<string, string | number> }
const HELP: Record<AssignmentMode, string> = {
  manual: "Tickets wait in the queue until a staff member claims one or an admin assigns it.",
  round_robin: "New tickets go to the next available staff member in turn.",
  workload: "New tickets go to the available staff member with the fewest active tickets.",
};

export default function AdminSettings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "settings"], queryFn: () => authed<Settings>("/admin/settings") });
  const save = useMutation({ mutationFn: (mode: AssignmentMode) => authed("/admin/settings/assignment-mode", { method: "PUT", body: { mode } }), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "settings"] }) });
  return (
    <>
      <PageTitle title="Settings" />
      {!data ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <div className="max-w-2xl space-y-10">
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Ticket assignment</h2>
            <Select value={data.assignmentMode} onValueChange={(v) => save.mutate(v as AssignmentMode)}>
              <SelectTrigger aria-label="Assignment mode" className="w-64" data-testid="assignment-mode"><SelectValue /></SelectTrigger>
              <SelectContent>{ASSIGNMENT_MODES.map((m) => <SelectItem key={m} value={m}>{m.replace("_", " ").replace(/^./, (c) => c.toUpperCase())}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-sm text-body">{HELP[data.assignmentMode]}</p>
          </section>
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">AI configuration (read-only)</h2>
            <p className="text-sm text-muted-foreground">These are set in the deployment environment, so changing one is a deploy decision.</p>
            <dl className="divide-y divide-rule rounded-lg border border-rule text-sm">
              {Object.entries(data.ai).map(([k, v]) => <div key={k} className="flex justify-between px-3 py-2"><dt className="text-body">{k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())}</dt><dd className="font-medium text-ink">{String(v)}</dd></div>)}
            </dl>
          </section>
        </div>
      )}
    </>
  );
}
