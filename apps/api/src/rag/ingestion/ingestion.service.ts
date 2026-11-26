import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { RagIngestReport, RagIngestResult } from "@support-ai/contracts";
import { ChunkingService } from "../chunking/chunking.service.js";
import { EmbeddingService } from "../embeddings/embedding.service.js";
import { DOCUMENT_STORE, RAG_CONFIG } from "../rag.constants.js";
import type { RagConfig } from "../rag.config.js";
import type { DocumentStore } from "../types/rag.types.js";
import { parseDocument } from "./document-parser.js";

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(ChunkingService) private readonly chunking: ChunkingService,
    @Inject(EmbeddingService) private readonly embeddings: EmbeddingService,
    @Inject(RAG_CONFIG) private readonly config: RagConfig,
  ) {}

  /** Ingest every `*.md` in the knowledge base. One bad file never aborts the rest. */
  async ingestDirectory(dir = this.config.knowledgeBaseDir): Promise<RagIngestReport> {
    const root = resolve(dir);
    const files = (await readdir(root)).filter((f) => f.endsWith(".md")).sort();
    const report: RagIngestReport = { embeddingModel: this.embeddings.model, embeddingTokens: 0, results: [] };
    for (const file of files) {
      const raw = await readFile(join(root, file), "utf8");
      const { result, tokens } = await this.ingestFile(file, raw);
      report.results.push(result);
      report.embeddingTokens += tokens;
    }
    return report;
  }

  async ingestFile(fileName: string, raw: string): Promise<{ result: RagIngestResult; tokens: number }> {
    try {
      const doc = parseDocument(fileName, raw);
      const existing = await this.store.findDocumentByTitle(doc.title);
      // Duplicate prevention: identical content already indexed with the current embedding model.
      if (existing && existing.checksum === doc.checksum && existing.embeddingModel === this.embeddings.model) {
        return { result: { file: fileName, status: "skipped_duplicate", chunks: 0 }, tokens: 0 };
      }
      const drafts = this.chunking.chunk(doc);
      // Embed first so a provider failure leaves the previously indexed version untouched.
      const { vectors, tokens } = await this.embeddings.embedDocuments(drafts.map((d) => d.embedText));
      const chunks = drafts.map((d, i) => ({
        ...d,
        metadata: { ...d.metadata, embeddingModel: this.embeddings.model },
        embedding: vectors[i]!,
      }));
      const { replaced } = await this.store.replaceDocument(
        { title: doc.title, category: doc.category, content: doc.body, version: doc.version, checksum: doc.checksum },
        chunks,
      );
      return { result: { file: fileName, status: replaced ? "updated" : "ingested", chunks: chunks.length }, tokens };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`ingest failed for ${fileName}: ${error}`);
      return { result: { file: fileName, status: "failed", chunks: 0, error }, tokens: 0 };
    }
  }
}
