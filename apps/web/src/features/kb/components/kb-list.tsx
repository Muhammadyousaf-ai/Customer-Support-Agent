"use client";

import { POLICY_CATEGORIES } from "@support-ai/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { authed } from "@/features/auth/auth.store";
import { ApiError } from "@/features/chat/services/api.client";
import { PageTitle } from "@/features/portal/components/bits";
import { label } from "@/features/tickets/components/ticket-list";
import { RetrievalTester } from "./retrieval-tester";

export interface KbDoc { id: string; title: string; category: string; status: string; publishedVersion: number | null; latestVersion: number; latestStatus: string; hasUnpublishedChanges: boolean; indexStatus: string; indexError: string | null; chunks: number | null; publishedAt: string | null; updatedAt: string }

export function KbList() {
  const qc = useQueryClient();
  const { data, error } = useQuery({ queryKey: ["kb", "list"], queryFn: () => authed<KbDoc[]>("/admin/kb/documents") });
  const [open, setOpen] = useState(false);
  const [meta, setMeta] = useState({ title: "", category: "refund" });
  const [uploadError, setUploadError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: () => {
      const f = file.current?.files?.[0];
      if (!f) throw new ApiError(400, "Choose a file first.");
      const body = new FormData();
      body.set("title", meta.title);
      body.set("category", meta.category);
      body.set("file", f);
      return authed<{ id: string }>("/admin/kb/upload", { method: "POST", body });
    },
    onSuccess: async () => { setOpen(false); setUploadError(null); await qc.invalidateQueries({ queryKey: ["kb"] }); },
    onError: (e) => setUploadError(e instanceof ApiError ? e.message : "Upload failed."),
  });
  return (
    <>
      <PageTitle title="Knowledge base" subtitle="Policy documents the AI assistant answers from. Only published versions are searchable." action={
        <div className="flex gap-2">
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button variant="outline">Upload file</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Upload a document</DialogTitle><DialogDescription>Markdown, text or PDF. Markdown with frontmatter needs no title or category. The upload becomes a draft; publish it to make it searchable.</DialogDescription></DialogHeader>
              <div className="space-y-3">
                <Input type="file" accept=".md,.txt,.pdf" ref={file} aria-label="Document file" data-testid="kb-file" />
                <Input placeholder="Title (for txt/pdf)" aria-label="Title" value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} />
                <Select value={meta.category} onValueChange={(v) => setMeta({ ...meta, category: v })}><SelectTrigger aria-label="Category"><SelectValue /></SelectTrigger><SelectContent>{POLICY_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{label(c)}</SelectItem>)}</SelectContent></Select>
                {uploadError && <p role="alert" className="text-sm text-destructive">{uploadError}</p>}
              </div>
              <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button loading={upload.isPending} onClick={() => upload.mutate()}>Upload</Button></DialogFooter>
            </DialogContent>
          </Dialog>
          <Button asChild><Link href="/admin/kb/new" data-testid="kb-new">New document</Link></Button>
        </div>
      } />
      {error ? <p role="alert" className="text-sm text-destructive">Could not load documents.</p> : (
        <div className="overflow-x-auto rounded-lg border border-rule">
          <table className="w-full text-left text-sm" data-testid="kb-table">
            <thead className="border-b border-rule text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="px-3 py-2">Document</th><th className="px-3 py-2">Category</th><th className="px-3 py-2">Published</th><th className="px-3 py-2">Indexing</th><th className="px-3 py-2">Chunks</th><th className="px-3 py-2">Updated</th></tr></thead>
            <tbody>
              {(data ?? []).map((d) => (
                <tr key={d.id} className="border-b border-rule last:border-0 hover:bg-accent/40">
                  <td className="px-3 py-2"><Link className="font-medium text-ink hover:underline" href={`/admin/kb/${d.id}`}>{d.title}</Link>{d.hasUnpublishedChanges && <div className="text-xs text-muted-foreground">Unpublished changes (v{d.latestVersion})</div>}</td>
                  <td className="px-3 py-2 text-body">{label(d.category)}</td>
                  <td className="px-3 py-2 text-body">{d.publishedVersion ? `v${d.publishedVersion}` : "Draft only"}</td>
                  <td className="px-3 py-2 text-body">{label(d.indexStatus)}{d.indexError ? <div className="text-xs text-destructive">{d.indexError}</div> : null}</td>
                  <td className="px-3 py-2">{d.chunks ?? "–"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{new Date(d.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
              {data?.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No documents yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-10"><RetrievalTester /></div>
    </>
  );
}
