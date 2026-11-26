import { Inject, Injectable } from "@nestjs/common";
import type { BillingPeriod, PolicyCategory, Tier } from "@support-ai/contracts";
import type pg from "pg";
import { PG_POOL } from "../../database/tokens.js";
import type {
  DocumentStore,
  DocumentSummary,
  NewChunk,
  NewDocument,
  RetrievedChunk,
  SearchFilters,
  StoredDocumentRef,
} from "../types/rag.types.js";

const toVector = (v: number[]) => `[${v.join(",")}]`;

interface ChunkRow {
  id: string;
  document_id: string;
  document_title: string;
  category: PolicyCategory;
  version: string;
  heading: string;
  content: string;
  applicable_tiers: Tier[];
  contract_types: BillingPeriod[];
  chunk_index: number;
  file_name: string | null;
  similarity: number;
}

@Injectable()
export class DocumentRepository implements DocumentStore {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async findDocumentByTitle(title: string): Promise<StoredDocumentRef | null> {
    const { rows } = await this.pool.query<{ id: string; checksum: string; embedding_model: string | null }>(
      `select d.id, d.checksum,
              (select c.metadata->>'embeddingModel' from document_chunks c where c.document_id = d.id limit 1) as embedding_model
         from documents d where d.title = $1`,
      [title],
    );
    const r = rows[0];
    return r ? { id: r.id, checksum: r.checksum, embeddingModel: r.embedding_model } : null;
  }

  /** Atomic: either the document and all its chunks are replaced, or nothing changes. */
  async replaceDocument(doc: NewDocument, chunks: NewChunk[]): Promise<{ documentId: string; replaced: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const existing = await client.query<{ id: string }>("select id from documents where title = $1 for update", [doc.title]);
      let documentId: string;
      const replaced = existing.rows.length > 0;
      if (replaced) {
        documentId = existing.rows[0]!.id;
        await client.query(
          "update documents set category=$2, content=$3, version=$4, checksum=$5 where id=$1",
          [documentId, doc.category, doc.content, doc.version, doc.checksum],
        );
        await client.query("delete from document_chunks where document_id = $1", [documentId]);
      } else {
        const ins = await client.query<{ id: string }>(
          "insert into documents (title, category, content, version, checksum) values ($1,$2,$3,$4,$5) returning id",
          [doc.title, doc.category, doc.content, doc.version, doc.checksum],
        );
        documentId = ins.rows[0]!.id;
      }
      for (const c of chunks) {
        await client.query(
          `insert into document_chunks
             (document_id, content, heading, embedding, applicable_tiers, contract_types, metadata, chunk_index)
           values ($1,$2,$3,$4::vector,$5,$6,$7::jsonb,$8)`,
          [documentId, c.content, c.heading, toVector(c.embedding), c.applicableTiers, c.contractTypes, JSON.stringify(c.metadata), c.chunkIndex],
        );
      }
      await client.query("commit");
      return { documentId, replaced };
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  async searchChunks(params: {
    embedding: number[];
    embeddingModel: string;
    filters: SearchFilters;
    limit: number;
  }): Promise<RetrievedChunk[]> {
    const { embedding, embeddingModel, filters, limit } = params;
    const { rows } = await this.pool.query<ChunkRow>(
      `select c.id, c.document_id, d.title as document_title, d.category, d.version, c.heading, c.content,
              c.applicable_tiers, c.contract_types, c.chunk_index, c.metadata->>'fileName' as file_name,
              1 - (c.embedding <=> $1::vector) as similarity
         from document_chunks c
         join documents d on d.id = c.document_id
        where c.metadata->>'embeddingModel' = $2
          and ($3::text is null or $3 = any(c.applicable_tiers))
          and ($4::text is null or $4 = any(c.contract_types))
        order by c.embedding <=> $1::vector
        limit $5`,
      [toVector(embedding), embeddingModel, filters.tier ?? null, filters.contractType ?? null, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      document: r.file_name ?? r.document_title,
      documentTitle: r.document_title,
      category: r.category,
      version: r.version,
      heading: r.heading,
      content: r.content,
      applicableTiers: r.applicable_tiers,
      contractTypes: r.contract_types,
      chunkIndex: r.chunk_index,
      similarity: Number(r.similarity),
    }));
  }

  async listDocuments(): Promise<DocumentSummary[]> {
    const { rows } = await this.pool.query<{
      id: string; title: string; category: PolicyCategory; version: string; checksum: string; created_at: Date; chunk_count: string;
    }>(
      `select d.id, d.title, d.category, d.version, d.checksum, d.created_at, count(c.id) as chunk_count
         from documents d left join document_chunks c on c.document_id = d.id
        group by d.id order by d.title`,
    );
    return rows.map((r) => ({
      id: r.id, title: r.title, category: r.category, version: r.version, checksum: r.checksum,
      chunkCount: Number(r.chunk_count), createdAt: r.created_at.toISOString(),
    }));
  }

  async deleteDocumentByTitle(title: string): Promise<boolean> {
    const r = await this.pool.query("delete from documents where title = $1", [title]);
    return (r.rowCount ?? 0) > 0;
  }

  async stats() {
    const { rows } = await this.pool.query<{ documents: string; chunks: string; pgvector: boolean }>(
      `select (select count(*) from documents) as documents,
              (select count(*) from document_chunks) as chunks,
              exists(select 1 from pg_extension where extname = 'vector') as pgvector`,
    );
    const r = rows[0]!;
    return { documents: Number(r.documents), chunks: Number(r.chunks), pgvector: r.pgvector };
  }
}
