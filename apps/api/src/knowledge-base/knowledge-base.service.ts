import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { PolicyCategory } from "@support-ai/contracts";
import { POLICY_CATEGORIES } from "@support-ai/contracts";
import type pg from "pg";
import { PDFParse } from "pdf-parse";
import { AuditService } from "../audit/audit.service.js";
import type { AuthUser } from "../auth/auth.types.js";
import { PG_POOL } from "../database/tokens.js";
import { ChunkingService } from "../rag/chunking/chunking.service.js";
import { DocumentParseError, parseDocument } from "../rag/ingestion/document-parser.js";
import { IngestionService } from "../rag/ingestion/ingestion.service.js";
import { DOCUMENT_STORE } from "../rag/rag.constants.js";
import { RagService } from "../rag/rag.service.js";
import type { DocumentStore } from "../rag/types/rag.types.js";

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "document";
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);

interface DocRow { id: string; title: string; category: string; status: string; published_version: number | null; created_at: Date; updated_at: Date }
interface VersionRow { version: number; status: string; index_status: string; index_error: string | null; chunks: number | null; created_at: Date; published_at: Date | null; created_by_name?: string | null }

/**
 * Knowledge-base management. The RAG store holds only what is *published*; drafts and history live in kb_document_versions.
 * Publishing embeds first and swaps atomically (IngestionService), so a failed index never disturbs the live version.
 */
@Injectable()
export class KnowledgeBaseService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(IngestionService) private readonly ingestion: IngestionService,
    @Inject(ChunkingService) private readonly chunking: ChunkingService,
    @Inject(RagService) private readonly rag: RagService,
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Documents ingested from the knowledge-base folder before this module existed are adopted as published v1. Idempotent. */
  async syncExisting(): Promise<void> {
    const { rows } = await this.pool.query<{ id: string; title: string; category: string; content: string; version: string; chunks: string }>(
      `select d.id, d.title, d.category, d.content, d.version, (select count(*) from document_chunks c where c.document_id = d.id) chunks
         from documents d where not exists (select 1 from kb_documents k where lower(k.title) = lower(d.title) and k.status <> 'deleted')`,
    );
    for (const d of rows) {
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        const k = await client.query<{ id: string }>("insert into kb_documents (title, category, status, published_version) values ($1,$2,'published',1) returning id", [d.title, d.category]);
        await client.query(
          "insert into kb_document_versions (document_id, version, source, status, index_status, chunks, published_at) values ($1,1,$2,'published','indexed',$3, now())",
          [k.rows[0]!.id, this.compose(d.title, d.category, d.version, d.content), Number(d.chunks)],
        );
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
    }
  }

  compose(title: string, category: string, version: string, body: string): string {
    return `---\ntitle: ${title}\ncategory: ${category}\nversion: ${version}\n---\n${body}\n`;
  }

  /** Turn an uploaded file into a markdown source. Markdown may carry its own frontmatter; txt/pdf need title+category. */
  async sourceFromUpload(file: { originalname: string; buffer: Buffer; mimetype: string }, meta: { title?: string; category?: string }): Promise<string> {
    const name = file.originalname.toLowerCase();
    let text: string;
    if (name.endsWith(".pdf")) {
      if (file.buffer.subarray(0, 5).toString("latin1") !== "%PDF-") throw new BadRequestException("The file is not a valid PDF.");
      const parser = new PDFParse({ data: new Uint8Array(file.buffer) });
      try {
        text = (await parser.getText()).text;
      } catch {
        throw new BadRequestException("The PDF could not be read (it may be encrypted or corrupted).");
      } finally {
        await parser.destroy().catch(() => undefined);
      }
    } else if (name.endsWith(".md") || name.endsWith(".txt")) {
      text = file.buffer.toString("utf8");
    } else {
      throw new BadRequestException("Only .md, .txt and .pdf files are supported.");
    }
    text = text.replace(/\u0000/g, "").trim();
    if (!text) throw new BadRequestException("The file has no extractable text (scanned PDFs need OCR first).");
    if (/^---\r?\n/.test(text)) return text; // already has frontmatter
    const title = meta.title?.trim();
    const category = meta.category as PolicyCategory | undefined;
    if (!title || !category || !POLICY_CATEGORIES.includes(category)) throw new BadRequestException("Provide a title and a valid category for files without frontmatter.");
    // A plain document has no section headings; give the chunker one so retrieval can cite it.
    const body = /^#{1,3}\s/m.test(text) ? text : `# ${title}\n\n## Overview\n\n${text}`;
    return this.compose(title, category, "1.0", body);
  }

  private validate(source: string) {
    try {
      return parseDocument("draft.md", source);
    } catch (e) {
      if (e instanceof DocumentParseError) throw new BadRequestException(e.message.replace(/^draft\.md: /, ""));
      throw e;
    }
  }

  // ---- reads --------------------------------------------------------------------------------------------------------------------
  async list() {
    await this.syncExisting();
    const { rows } = await this.pool.query(
      `select k.*, v.index_status, v.index_error, v.chunks, v.published_at,
              (select max(version) from kb_document_versions x where x.document_id = k.id) latest_version,
              (select status from kb_document_versions x where x.document_id = k.id order by version desc limit 1) latest_status
         from kb_documents k left join kb_document_versions v on v.document_id = k.id and v.version = k.published_version
        where k.status <> 'deleted' order by k.title`,
    );
    return rows.map((r) => ({
      id: r.id as string, title: r.title as string, category: r.category as string, status: r.status as string,
      publishedVersion: r.published_version as number | null, latestVersion: Number(r.latest_version), latestStatus: r.latest_status as string,
      hasUnpublishedChanges: r.latest_status === "draft" || r.latest_status === "failed",
      indexStatus: (r.index_status as string | null) ?? "not_indexed", indexError: r.index_error as string | null, chunks: r.chunks as number | null,
      publishedAt: iso(r.published_at), updatedAt: iso(r.updated_at)!,
    }));
  }

  private async row(id: string): Promise<DocRow> {
    const { rows } = await this.pool.query<DocRow>("select * from kb_documents where id = $1 and status <> 'deleted'", [id]);
    if (!rows[0]) throw new NotFoundException("Document not found.");
    return rows[0];
  }

  async get(id: string) {
    const d = await this.row(id);
    const { rows } = await this.pool.query<VersionRow & { source: string }>(
      `select v.version, v.status, v.index_status, v.index_error, v.chunks, v.created_at, v.published_at, v.source, u.display_name created_by_name
         from kb_document_versions v left join users u on u.id = v.created_by where v.document_id = $1 order by v.version desc`, [id]);
    return {
      id: d.id, title: d.title, category: d.category, status: d.status, publishedVersion: d.published_version,
      source: rows[0]?.source ?? "", // latest (what the editor opens)
      versions: rows.map((v) => ({ version: v.version, status: v.status, indexStatus: v.index_status, indexError: v.index_error, chunks: v.chunks, createdAt: iso(v.created_at)!, publishedAt: iso(v.published_at), createdBy: v.created_by_name ?? null })),
    };
  }

  async versionSource(id: string, version: number): Promise<string> {
    await this.row(id);
    const { rows } = await this.pool.query<{ source: string }>("select source from kb_document_versions where document_id = $1 and version = $2", [id, version]);
    if (!rows[0]) throw new NotFoundException("Version not found.");
    return rows[0].source;
  }

  /** What the chunker will produce — no embedding, no side effects. */
  async preview(source: string) {
    const doc = this.validate(source);
    const drafts = this.chunking.chunk(doc);
    return { title: doc.title, category: doc.category, version: doc.version, chunks: drafts.map((c) => ({ index: c.chunkIndex, heading: c.heading, content: c.content, applicableTiers: c.applicableTiers, contractTypes: c.contractTypes })) };
  }

  // ---- writes -------------------------------------------------------------------------------------------------------------------
  async create(admin: AuthUser, source: string) {
    const doc = this.validate(source);
    this.chunking.chunk(doc); // reject documents that cannot be chunked now rather than at publish time
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const k = await client.query<{ id: string }>("insert into kb_documents (title, category, created_by) values ($1,$2,$3) returning id", [doc.title, doc.category, admin.id]);
      await client.query("insert into kb_document_versions (document_id, version, source, created_by) values ($1,1,$2,$3)", [k.rows[0]!.id, source, admin.id]);
      await this.audit.log({ actor: "user", actorUserId: admin.id, actorRole: "admin", action: "kb.created", entityType: "kb_document", entityId: k.rows[0]!.id, newValue: { title: doc.title } }, client);
      await client.query("commit");
      return this.get(k.rows[0]!.id);
    } catch (e) {
      await client.query("rollback");
      if ((e as { code?: string }).code === "23505") throw new ConflictException("A document with this title already exists.");
      throw e;
    } finally {
      client.release();
    }
  }

  /** Saving never touches the live index. A draft that is still unpublished is overwritten; otherwise a new version starts. */
  async saveDraft(admin: AuthUser, id: string, source: string) {
    const d = await this.row(id);
    const doc = this.validate(source);
    this.chunking.chunk(doc);
    if (doc.title.toLowerCase() !== d.title.toLowerCase() && d.published_version !== null) {
      throw new BadRequestException("A published document cannot be renamed. Create a new document instead.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const latest = await client.query<{ version: number; status: string }>("select version, status from kb_document_versions where document_id = $1 order by version desc limit 1 for update", [id]);
      const l = latest.rows[0];
      if (l && (l.status === "draft" || l.status === "failed")) {
        await client.query("update kb_document_versions set source=$3, status='draft', index_status='not_indexed', index_error=null, created_by=$4 where document_id=$1 and version=$2", [id, l.version, source, admin.id]);
      } else {
        await client.query("insert into kb_document_versions (document_id, version, source, created_by) values ($1,$2,$3,$4)", [id, (l?.version ?? 0) + 1, source, admin.id]);
      }
      await client.query("update kb_documents set title=$2, category=$3, updated_at=now() where id=$1", [id, doc.title, doc.category]);
      await this.audit.log({ actor: "user", actorUserId: admin.id, actorRole: "admin", action: "kb.draft_saved", entityType: "kb_document", entityId: id }, client);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      if ((e as { code?: string }).code === "23505") throw new ConflictException("A document with this title already exists.");
      throw e;
    } finally {
      client.release();
    }
    return this.get(id);
  }

  /** Embed and publish a version. On any failure the previously published version stays live and the attempt is recorded. */
  async publish(admin: AuthUser, id: string, version?: number) {
    const d = await this.row(id);
    const target = version ?? (await this.pool.query<{ v: number }>("select max(version) v from kb_document_versions where document_id = $1", [id])).rows[0]!.v;
    const source = await this.versionSource(id, target);
    const doc = this.validate(source);
    if (doc.title.toLowerCase() !== d.title.toLowerCase()) throw new BadRequestException("The version's title no longer matches the document.");
    const { result } = await this.ingestion.ingestFile(`${slug(d.title)}.md`, source);
    if (result.status === "failed") {
      await this.pool.query("update kb_document_versions set status='failed', index_status='failed', index_error=$3 where document_id=$1 and version=$2", [id, target, (result.error ?? "indexing failed").slice(0, 500)]);
      await this.audit.log({ actor: "user", actorUserId: admin.id, actorRole: "admin", action: "kb.publish_failed", entityType: "kb_document", entityId: id, newValue: { version: target, error: result.error } });
      return { ok: false as const, error: result.error ?? "indexing failed", publishedVersion: d.published_version };
    }
    // The live document may have been indexed already (skipped_duplicate), so the chunk count comes from the store.
    const stored = (await this.store.listDocuments()).find((x) => x.title === doc.title);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("update kb_document_versions set status='superseded' where document_id=$1 and status='published'", [id]);
      await client.query("update kb_document_versions set status='published', index_status='indexed', index_error=null, chunks=$3, published_at=now() where document_id=$1 and version=$2", [id, target, stored?.chunkCount ?? result.chunks]);
      await client.query("update kb_documents set status='published', published_version=$2, category=$3, updated_at=now() where id=$1", [id, target, doc.category]);
      await this.audit.log({ actor: "user", actorUserId: admin.id, actorRole: "admin", action: "kb.published", entityType: "kb_document", entityId: id, previousValue: { version: d.published_version }, newValue: { version: target, chunks: stored?.chunkCount ?? result.chunks } }, client);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
    return { ok: true as const, publishedVersion: target, chunks: stored?.chunkCount ?? result.chunks };
  }

  /** Re-embed the live version (e.g. after changing the embedding model). Forced: it ignores the duplicate-content shortcut. */
  async reindex(admin: AuthUser, id: string) {
    const d = await this.row(id);
    if (d.published_version === null) throw new ConflictException("Only published documents can be re-indexed.");
    const source = await this.versionSource(id, d.published_version);
    // A trailing newline changes the checksum, which bypasses the duplicate shortcut without altering the content.
    const forced = source.endsWith("\n\n") ? source.trimEnd() + "\n" : `${source.trimEnd()}\n\n`;
    const { result } = await this.ingestion.ingestFile(`${slug(d.title)}.md`, forced);
    await this.audit.log({ actor: "user", actorUserId: admin.id, actorRole: "admin", action: result.status === "failed" ? "kb.reindex_failed" : "kb.reindexed", entityType: "kb_document", entityId: id, newValue: { status: result.status, error: result.error } });
    if (result.status === "failed") {
      await this.pool.query("update kb_document_versions set index_error=$3 where document_id=$1 and version=$2", [id, d.published_version, (result.error ?? "").slice(0, 500)]);
      return { ok: false as const, error: result.error ?? "indexing failed" };
    }
    await this.pool.query("update kb_document_versions set index_status='indexed', index_error=null, chunks=$3 where document_id=$1 and version=$2", [id, d.published_version, result.chunks]);
    return { ok: true as const, chunks: result.chunks };
  }

  /** Restoring creates a new draft from an old version (history is never rewritten); optionally publishes it straight away. */
  async restore(admin: AuthUser, id: string, version: number, publish = false) {
    const source = await this.versionSource(id, version);
    await this.pool.query(
      `insert into kb_document_versions (document_id, version, source, created_by)
       select $1, coalesce(max(version),0)+1, $2, $3 from kb_document_versions where document_id = $1`, [id, source, admin.id]);
    await this.audit.log({ actor: "user", actorUserId: admin.id, actorRole: "admin", action: "kb.restored", entityType: "kb_document", entityId: id, newValue: { fromVersion: version } });
    return publish ? { restored: true, ...(await this.publish(admin, id)) } : { restored: true, ...(await this.get(id)) };
  }

  /** Removes the document, its chunks and its embeddings from retrieval. History stays for audit. */
  async remove(admin: AuthUser, id: string) {
    const d = await this.row(id);
    await this.store.deleteDocumentByTitle(d.title);
    await this.pool.query("update kb_documents set status='deleted', updated_at=now() where id=$1", [id]);
    await this.audit.log({ actor: "user", actorUserId: admin.id, actorRole: "admin", action: "kb.deleted", entityType: "kb_document", entityId: id, previousValue: { title: d.title, version: d.published_version } });
  }

  /** Retrieval test against the live index, exactly as the agent would query it. */
  test(input: { query: string; tier?: "free" | "basic" | "pro" | "enterprise"; contractType?: "monthly" | "annual" }) {
    return this.rag.search({ query: input.query, tier: input.tier, contractType: input.contractType, topK: 5 });
  }
}
