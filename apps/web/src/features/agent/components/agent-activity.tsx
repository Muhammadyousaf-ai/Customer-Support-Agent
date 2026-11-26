"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { RunView } from "@/features/chat/types";
import { ToolExecutionItem } from "./tool-execution-item";

/** Live timeline of what the agent is doing. Rendered from backend events; nothing about the sequence is hardcoded. */
export function AgentActivity({ run, live }: { run: RunView; live: boolean }) {
  const [open, setOpen] = useState(live);
  const real = run.tools.filter((t) => t.tool !== "confirmation");
  if (run.tools.length === 0 && !live) return null;
  const done = real.filter((t) => t.status === "completed").length;
  const expanded = live || open;
  const title = live && run.tools.length === 0 ? "Agent is working…" : `${done} of ${real.length} steps completed`;

  return (
    <section aria-label="Agent activity" data-testid="agent-activity" className="my-2 rounded-xl border border-border-soft bg-surface px-4 py-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
        {!live && real.length > 0 && (
          <Button variant="ghost" size="xs" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? "Hide agent steps" : "Show agent steps"}>
            {open ? <ChevronDown /> : <ChevronRight />} {open ? "Hide" : "Show"}
          </Button>
        )}
      </div>
      {expanded && run.tools.length > 0 && (
        <ul className="divide-y divide-border-soft" aria-live="polite">
          {run.tools.map((t) => (
            <ToolExecutionItem key={t.id} item={t} />
          ))}
        </ul>
      )}
    </section>
  );
}
