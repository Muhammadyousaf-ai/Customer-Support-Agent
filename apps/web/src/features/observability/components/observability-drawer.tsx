"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConversationsStore } from "@/features/chat/store/conversations.store";
import { useObservability } from "../hooks/use-observability";
import { useObservabilityStore, type ObsTab } from "../store/observability.store";
import { ErrorInspector } from "./errors/error-inspector";
import { GuardrailInspector } from "./guardrails/guardrail-inspector";
import { HistoryList } from "./history-list";
import { PromptInspector } from "./prompts/prompt-inspector";
import { RetrievalInspector } from "./retrieval/retrieval-inspector";
import { RunOverview } from "./run-overview";
import { ExecutionTimeline } from "./timeline/execution-timeline";
import { ToolInspector } from "./tools/tool-inspector";
import { UsagePanel } from "./usage/usage-panel";
import { VoiceDiagnosticsPanel } from "./voice/voice-diagnostics";

const TABS: Array<[ObsTab, string]> = [["overview", "Overview"], ["timeline", "Timeline"], ["prompts", "Prompts"], ["tools", "Tools"], ["rag", "RAG"], ["guardrails", "Guardrails"], ["usage", "Usage"], ["voice", "Voice"], ["errors", "Errors"], ["history", "History"]];

/**
 * Developer-facing technical detail for the open conversation: collapsible, never blocks the chat, and updates while a run
 * is active. Different from the customer-facing activity indicators: this shows prompts, spans, costs and failures.
 */
export function ObservabilityDrawer({ onClose }: { onClose?: () => void }) {
  const { items, activeId } = useConversationsStore();
  const conv = items.find((c) => c.id === activeId) ?? null;
  const { tab, setTab, select, adminKey, setAdminKey } = useObservabilityStore();
  const { history, traces, voice, runId, following } = useObservability(conv ? { id: conv.id, token: conv.token } : null);
  const t = traces.data;
  const restricted = t?.access === "owner";

  return (
    <aside aria-label="Observability" data-testid="observability-drawer" className="flex w-drawer shrink-0 flex-col border-l border-rule bg-surface lg:w-[34rem]">
      <header className="flex items-center justify-between gap-2 border-b border-rule px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">Observability</h2>
          <p className="truncate text-xs text-faint" data-testid="obs-run-label">{runId ? `${runId.slice(0, 12)}… · ${t?.overview.mode ?? ""} · ${t ? t.overview.status.replace("_", " ") : "loading"}${following ? " · live" : ""}` : "No run selected"}</p>
        </div>
        {onClose && <Button variant="ghost" size="icon-sm" aria-label="Close observability" onClick={onClose}><X /></Button>}
      </header>
      <div className="border-b border-rule px-4 py-2">
        <Input type="password" aria-label="Administrator key" data-testid="admin-key" placeholder="Administrator key (for prompts and tool data)" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} className="h-8 text-xs" />
      </div>
      {!conv ? <p className="p-4 text-sm text-faint">Open a conversation to inspect its runs.</p> : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as ObsTab)} className="min-h-0 flex-1 gap-0">
          <TabsList className="mx-4 mt-2 h-auto! w-auto flex-wrap justify-start gap-0.5">
            {TABS.map(([v, label]) => <TabsTrigger key={v} value={v} data-testid={`obs-tab-${v}`} className="h-7 flex-none px-2 text-xs">{label}</TabsTrigger>)}
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-testid="obs-panel">
            {tab === "history" ? (
              <HistoryList runs={history.data ?? []} selectedId={runId} onSelect={(id) => { select(id); setTab("overview"); }} />
            ) : !runId ? (
              <p className="text-sm text-faint" data-testid="obs-empty">Prompt traces, latency, token usage and estimated cost appear here once a run starts.</p>
            ) : traces.isError ? (
              <p className="text-sm text-ink" role="alert">Couldn&apos;t load this trace ({String((traces.error as { status?: number })?.status ?? "network")}). {adminKey ? "Check the administrator key." : ""}</p>
            ) : !t ? (
              <div className="space-y-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
            ) : (
              <>
                {following ? null : <Button variant="ghost" size="xs" className="mb-2" onClick={() => select(null)}>Follow the latest run</Button>}
                <TabsContent value="overview"><RunOverview o={t.overview} /></TabsContent>
                <TabsContent value="timeline"><ExecutionTimeline spans={t.spans} restricted={restricted} /></TabsContent>
                <TabsContent value="prompts"><PromptInspector models={t.models} /></TabsContent>
                <TabsContent value="tools"><ToolInspector tools={t.tools} /></TabsContent>
                <TabsContent value="rag"><RetrievalInspector retrievals={t.retrievals} /></TabsContent>
                <TabsContent value="guardrails"><GuardrailInspector g={t.guardrails} /></TabsContent>
                <TabsContent value="usage"><UsagePanel u={t.usage} /></TabsContent>
                <TabsContent value="voice">{voice.data ? <VoiceDiagnosticsPanel d={voice.data} /> : <p className="text-sm text-faint" data-testid="voice-none">This run was not part of a voice session.</p>}</TabsContent>
                <TabsContent value="errors"><ErrorInspector e={t.errors} /></TabsContent>
              </>
            )}
          </div>
        </Tabs>
      )}
    </aside>
  );
}
