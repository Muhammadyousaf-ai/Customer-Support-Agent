"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ModelInvocation } from "../../types";
import { json, ms, tokens, usd } from "../../format";
import { Pre, Restricted } from "../metric-card";

const SOURCE: Record<string, string> = { provider_reported: "provider-reported", estimated: "estimated (provider reported no usage)", unavailable: "unavailable" };

export function ModelInvocationView({ m }: { m: ModelInvocation }) {
  return (
    <section className="space-y-2 rounded-lg border border-rule bg-background p-3" data-testid="model-invocation" data-purpose={m.purpose}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink">Call {m.index} · {m.purpose.replace("_", " ")}</h4>
        <span className="text-xs text-faint">{m.provider} · {m.model}</span>
      </header>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-faint">Duration</dt><dd className="tabular-nums text-ink">{ms(m.durationMs)}</dd>
        <dt className="text-faint">Tokens (in / out)</dt><dd className="tabular-nums text-ink">{tokens(m.usage.inputTextTokens + m.usage.cachedInputTokens)} / {tokens(m.usage.outputTextTokens)}{m.usage.cachedInputTokens ? ` (${tokens(m.usage.cachedInputTokens)} cached)` : ""}</dd>
        <dt className="text-faint">Usage</dt><dd className="text-ink">{SOURCE[m.usageSource] ?? m.usageSource}</dd>
        <dt className="text-faint">Estimated cost</dt><dd className="tabular-nums text-ink">{usd(m.estimatedCostUsd)}</dd>
        <dt className="text-faint">Finish reason</dt><dd className="text-ink">{m.finishReason ?? "n/a"}</dd>
        <dt className="text-faint">Prompt version</dt><dd className="font-mono text-ink">{m.promptVersion ?? "n/a"}</dd>
        <dt className="text-faint">Status</dt><dd className="text-ink">{m.status === "ok" ? "Completed" : `Failed (${m.errorCode ?? "error"})`}</dd>
      </dl>
      {m.costNote && <p className="text-xs text-faint">{m.costNote}</p>}
      {m.restricted ? <Restricted what="The prompt, tools and model output" /> : <Detail m={m} />}
    </section>
  );
}

function Detail({ m }: { m: ModelInvocation }) {
  return (
    <Tabs defaultValue="system">
      <TabsList>
        <TabsTrigger value="system">System</TabsTrigger><TabsTrigger value="input">Input</TabsTrigger><TabsTrigger value="tools">Tools</TabsTrigger><TabsTrigger value="output">Output</TabsTrigger>
      </TabsList>
      <TabsContent value="system"><Pre testId="prompt-system">{m.systemPrompt ?? ""}</Pre></TabsContent>
      <TabsContent value="input"><Pre testId="prompt-input">{json(m.messages)}</Pre></TabsContent>
      <TabsContent value="tools"><Pre testId="prompt-tools">{json(m.tools)}</Pre></TabsContent>
      <TabsContent value="output"><Pre testId="prompt-output">{json(m.output)}</Pre></TabsContent>
    </Tabs>
  );
}

export function PromptInspector({ models }: { models: ModelInvocation[] }) {
  const [open, setOpen] = useState(0);
  if (!models.length) return <p className="text-sm text-faint">No model calls recorded for this run.</p>;
  return (
    <div className="space-y-3" data-testid="prompt-inspector">
      <p className="text-xs text-faint">Actual application inputs and observable outputs, sanitized. This is not the model&apos;s private reasoning.</p>
      <ol className="flex flex-wrap gap-1" aria-label="Model calls">
        {models.map((m, i) => (
          <li key={m.invocationId}>
            <Button type="button" variant="ghost" size="xs" data-testid="model-call-button" aria-pressed={open === i} onClick={() => setOpen(i)} className={`rounded border px-2 text-xs ${open === i ? "border-ink bg-wash text-ink" : "border-rule text-faint"}`}>
              {m.index} · {m.purpose.replace("_check", "")}
            </Button>
          </li>
        ))}
      </ol>
      <ModelInvocationView m={models[open] ?? models[0]!} />
    </div>
  );
}
