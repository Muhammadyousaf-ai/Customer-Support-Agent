"use client";

import type { RagSearchResponse } from "@support-ai/contracts";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { authed } from "@/features/auth/auth.store";
import { ApiError } from "@/features/chat/services/api.client";
import { label } from "@/features/tickets/components/ticket-list";

const ANY = "any";

/** Runs the exact retrieval the agent uses, so an admin can check what a customer question would be grounded on. */
export function RetrievalTester() {
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState(ANY);
  const [contract, setContract] = useState(ANY);
  const test = useMutation({
    mutationFn: () => authed<RagSearchResponse>("/admin/kb/test", { method: "POST", body: { query, ...(tier !== ANY ? { tier } : {}), ...(contract !== ANY ? { contractType: contract } : {}) } }),
  });
  const r = test.data;
  return (
    <section className="space-y-3" aria-label="Retrieval test">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Retrieval test</h2>
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Test question" placeholder="Ask a customer question…" className="w-96" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && query.trim().length >= 2) test.mutate(); }} data-testid="kb-test-query" />
        <Select value={tier} onValueChange={setTier}><SelectTrigger aria-label="Tier" className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={ANY}>Any tier</SelectItem>{["free", "basic", "pro", "enterprise"].map((t) => <SelectItem key={t} value={t}>{label(t)}</SelectItem>)}</SelectContent></Select>
        <Select value={contract} onValueChange={setContract}><SelectTrigger aria-label="Contract" className="w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={ANY}>Any contract</SelectItem><SelectItem value="monthly">Monthly</SelectItem><SelectItem value="annual">Annual</SelectItem></SelectContent></Select>
        <Button variant="outline" loading={test.isPending} disabled={query.trim().length < 2} onClick={() => test.mutate()} data-testid="kb-test-run">Test retrieval</Button>
      </div>
      {test.error && <p role="alert" className="text-sm text-destructive">{test.error instanceof ApiError ? test.error.message : "Test failed."}</p>}
      {r && (
        <div className="space-y-2" data-testid="kb-test-result">
          <p className="text-sm text-body">Outcome: <strong className="text-ink">{label(r.status)}</strong> · confidence {r.confidenceScore.toFixed(2)} · threshold {r.threshold}</p>
          <ol className="space-y-2">
            {r.sources.map((s) => <li key={s.chunkId} className="rounded-lg border border-rule p-3"><p className="text-xs text-muted-foreground">{s.documentTitle} › {s.heading} · similarity {s.similarity.toFixed(3)} · v{s.policyVersion}</p><p className="mt-1 line-clamp-4 whitespace-pre-wrap text-sm text-ink">{s.content}</p></li>)}
            {r.sources.length === 0 && <li className="text-sm text-muted-foreground">No chunk passed the similarity threshold: the assistant would escalate instead of answering.</li>}
          </ol>
          {r.rejected.length > 0 && <p className="text-xs text-muted-foreground">{r.rejected.length} chunk(s) were retrieved but fell below the threshold.</p>}
        </div>
      )}
    </section>
  );
}
