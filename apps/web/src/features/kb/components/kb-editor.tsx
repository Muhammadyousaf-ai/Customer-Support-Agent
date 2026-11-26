"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { authed } from "@/features/auth/auth.store";
import { ApiError } from "@/features/chat/services/api.client";
import { label } from "@/features/tickets/components/ticket-list";

interface Version { version: number; status: string; indexStatus: string; indexError: string | null; chunks: number | null; createdAt: string; publishedAt: string | null; createdBy: string | null }
interface Doc { id: string; title: string; category: string; status: string; publishedVersion: number | null; source: string; versions: Version[] }
interface Preview { title: string; category: string; version: string; chunks: Array<{ index: number; heading: string; content: string; applicableTiers: string[]; contractTypes: string[] }> }

const TEMPLATE = `---
title: New policy title
category: refund
version: 1.0
---
# New policy title

## Overview

Describe the policy here. Use one "##" heading per topic so each section is retrieved on its own.
`;
const err = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong.");

export function KbEditor({ id }: { id: string | null }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { data: doc } = useQuery({ queryKey: ["kb", "doc", id], queryFn: () => authed<Doc>(`/admin/kb/documents/${id}`), enabled: !!id });
  const [source, setSource] = useState(id ? "" : TEMPLATE);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Load the editor text when a different document/version arrives (adjusting state during render, not in an effect).
  const docKey = doc ? `${doc.id}:${doc.versions[0]?.version}` : null;
  if (doc && docKey !== loadedFor) { setLoadedFor(docKey); setSource(doc.source); }

  const refresh = () => qc.invalidateQueries({ queryKey: ["kb"] });
  const run = useMutation({
    mutationFn: async (kind: "save" | "preview" | "publish" | "reindex") => {
      setMessage(null);
      if (kind === "preview") return setPreview(await authed<Preview>("/admin/kb/preview", { method: "POST", body: { source } }));
      let docId = id;
      if (kind === "save" || kind === "publish") {
        if (!docId) docId = (await authed<Doc>("/admin/kb/documents", { method: "POST", body: { source } })).id;
        else if (doc && source !== doc.source) await authed(`/admin/kb/documents/${docId}`, { method: "PUT", body: { source } });
      }
      if (kind === "publish") {
        const r = await authed<{ ok: boolean; error?: string; chunks?: number }>(`/admin/kb/documents/${docId}/publish`, { method: "POST", body: {} });
        setMessage(r.ok ? { kind: "ok", text: `Published and indexed (${r.chunks} chunks).` } : { kind: "error", text: `Indexing failed: ${r.error}. The previous published version is still live.` });
      } else if (kind === "reindex") {
        const r = await authed<{ ok: boolean; error?: string; chunks?: number }>(`/admin/kb/documents/${docId}/reindex`, { method: "POST" });
        setMessage(r.ok ? { kind: "ok", text: `Re-indexed (${r.chunks} chunks).` } : { kind: "error", text: `Re-index failed: ${r.error}` });
      } else setMessage({ kind: "ok", text: "Draft saved. It is not searchable until published." });
      await refresh();
      if (!id && docId) router.replace(`/admin/kb/${docId}`);
    },
    onError: (e) => setMessage({ kind: "error", text: err(e) }),
  });
  const restore = useMutation({
    mutationFn: (v: number) => authed(`/admin/kb/documents/${id}/versions/${v}/restore`, { method: "POST", body: {} }),
    onSuccess: async () => { setMessage({ kind: "ok", text: "Restored as a new draft. Review it and publish." }); setLoadedFor(null); await refresh(); },
    onError: (e) => setMessage({ kind: "error", text: err(e) }),
  });
  const view = useMutation({ mutationFn: async (v: number) => (await authed<{ source: string }>(`/admin/kb/documents/${id}/versions/${v}`)).source, onSuccess: (s) => setSource(s) });
  const remove = useMutation({
    mutationFn: () => authed(`/admin/kb/documents/${id}`, { method: "DELETE" }),
    onSuccess: async () => { toast.success("Document deleted"); await refresh(); router.replace("/admin/kb"); },
    onError: (e) => toast.error(`Could not delete the document. ${err(e)}`),
  });
  const busy = run.isPending;

  return (
    <div className="space-y-6">
      <div>
        <Link className="text-sm text-primary" href="/admin/kb">← Knowledge base</Link>
        <h1 className="mt-2 text-2xl font-semibold text-ink">{doc?.title ?? "New document"}</h1>
        {doc && <p className="mt-1 text-sm text-muted-foreground">{label(doc.category)} · {doc.publishedVersion ? `Published v${doc.publishedVersion}` : "Not published"}</p>}
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-3">
          <Textarea aria-label="Document source" className="min-h-[28rem] font-mono text-sm" spellCheck={false} value={source} onChange={(e) => setSource(e.target.value)} data-testid="kb-source" />
          <p className="text-xs text-muted-foreground">Markdown with frontmatter (title, category, version). Tier and contract applicability can be set per section with an HTML comment under the heading, as in the existing policies.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => run.mutate("preview")} data-testid="kb-preview">Preview chunks</Button>
            <Button variant="outline" loading={busy && run.variables === "save"} disabled={busy} onClick={() => run.mutate("save")} data-testid="kb-save">Save draft</Button>
            <Button loading={busy && run.variables === "publish"} disabled={busy} onClick={() => run.mutate("publish")} data-testid="kb-publish">Publish</Button>
            {doc?.publishedVersion && <Button variant="outline" disabled={busy} onClick={() => run.mutate("reindex")}>Re-index</Button>}
            {id && <Button variant="outline" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete</Button>}
          </div>
          {message && <p role={message.kind === "error" ? "alert" : "status"} className={`text-sm ${message.kind === "error" ? "text-destructive" : "text-body"}`} data-testid="kb-message">{message.text}</p>}
          {preview && (
            <section className="space-y-2" data-testid="kb-preview-result">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{preview.chunks.length} chunks will be indexed</h2>
              {preview.chunks.map((c) => <div key={c.index} className="rounded-lg border border-rule p-3"><p className="text-xs text-muted-foreground">{c.heading} · tiers: {c.applicableTiers.join(", ")} · contracts: {c.contractTypes.join(", ")}</p><p className="mt-1 whitespace-pre-wrap text-sm text-ink">{c.content}</p></div>)}
            </section>
          )}
        </div>
        <aside className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Versions</h2>
          {!doc ? <p className="text-sm text-muted-foreground">Save the document to start its history.</p> : (
            <ol className="space-y-2" data-testid="kb-versions">
              {doc.versions.map((v) => (
                <li key={v.version} className="rounded-lg border border-rule p-3 text-sm">
                  <p className="font-medium text-ink">Version {v.version} · {label(v.status)}</p>
                  <p className="text-xs text-muted-foreground">{new Date(v.createdAt).toLocaleString()}{v.createdBy ? ` · ${v.createdBy}` : ""}{v.chunks ? ` · ${v.chunks} chunks` : ""}</p>
                  {v.indexError && <p className="mt-1 text-xs text-destructive">{v.indexError}</p>}
                  <div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => view.mutate(v.version)}>View</Button>{v.status !== "published" && <Button size="sm" variant="outline" onClick={() => restore.mutate(v.version)}>Restore</Button>}</div>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Delete this document?</AlertDialogTitle><AlertDialogDescription>It is removed from retrieval immediately, together with its embeddings. The assistant will no longer be able to answer from it. Version history is kept in the audit trail.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => remove.mutate()}>Delete document</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
