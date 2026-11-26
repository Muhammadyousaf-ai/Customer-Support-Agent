import { Module } from "@nestjs/common";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";
import { AdminGuard } from "./admin.guard.js";
import { ChunkingService } from "./chunking/chunking.service.js";
import { ConfidenceService } from "./confidence/confidence.service.js";
import { LlmEvidenceVerifier } from "./confidence/evidence-verifier.js";
import { HeuristicEvidenceVerifier } from "./confidence/heuristic-verifier.js";
import { EmbeddingService } from "./embeddings/embedding.service.js";
import { LocalHashEmbedder } from "./embeddings/local-hash.embedder.js";
import { OpenAiEmbedder } from "./embeddings/openai.embedder.js";
import { IngestionService } from "./ingestion/ingestion.service.js";
import { resolveRagConfig, type RagConfig } from "./rag.config.js";
import { DOCUMENT_STORE, EMBEDDER, EVIDENCE_VERIFIER, RAG_CONFIG } from "./rag.constants.js";
import { RagController } from "./rag.controller.js";
import { RagService } from "./rag.service.js";
import { DocumentRepository } from "./repositories/document.repository.js";
import { RankingService } from "./retrieval/ranking.service.js";
import { RetrievalService } from "./retrieval/retrieval.service.js";

@Module({
  controllers: [RagController],
  providers: [
    { provide: RAG_CONFIG, useFactory: (env: Env) => resolveRagConfig(env), inject: [ENV] },
    {
      provide: EMBEDDER,
      useFactory: (c: RagConfig) =>
        c.embeddingsProvider === "openai" ? new OpenAiEmbedder(c.embeddingModel, c.openAiApiKey) : new LocalHashEmbedder(),
      inject: [RAG_CONFIG],
    },
    {
      provide: EVIDENCE_VERIFIER,
      useFactory: (c: RagConfig) =>
        c.verifier === "llm" ? new LlmEvidenceVerifier(c.openAiApiKey, c.chatModel) : new HeuristicEvidenceVerifier(),
      inject: [RAG_CONFIG],
    },
    { provide: DOCUMENT_STORE, useExisting: DocumentRepository },
    DocumentRepository,
    EmbeddingService,
    ChunkingService,
    RankingService,
    RetrievalService,
    ConfidenceService,
    IngestionService,
    RagService,
    AdminGuard,
  ],
  exports: [RagService, IngestionService, ChunkingService, DOCUMENT_STORE],
})
export class RagModule {}
