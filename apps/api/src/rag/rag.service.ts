import { performance } from "node:perf_hooks";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { RagHealth } from "./types/rag.types.js";
import type { RagSearchRequest, RagSearchResponse, RagSource, RagStatus } from "@support-ai/contracts";
import { ENV } from "../config/tokens.js";
import type { Env } from "../config/env.js";
import { ConfidenceService } from "./confidence/confidence.service.js";
import { EmbeddingService } from "./embeddings/embedding.service.js";
import { DOCUMENT_STORE, EVIDENCE_VERIFIER, RAG_CONFIG } from "./rag.constants.js";
import type { RagConfig } from "./rag.config.js";
import { RetrievalService } from "./retrieval/retrieval.service.js";
import { specificityOf } from "./retrieval/ranking.service.js";
import { withSpan } from "../observability/tracing/tracing.js";
import type { DocumentStore, EvidenceVerifier, RetrievedChunk, SearchFilters } from "./types/rag.types.js";

const round = (n: number, digits = 4) => Number(n.toFixed(digits));
const ms = (from: number) => Math.round(performance.now() - from);

function toSource(c: RetrievedChunk): RagSource {
  return {
    chunkId: c.id,
    document: c.document,
    documentTitle: c.documentTitle,
    category: c.category,
    policyVersion: c.version,
    heading: c.heading,
    content: c.content,
    similarity: round(c.similarity),
    specificity: specificityOf(c),
    applicableTiers: c.applicableTiers,
    contractTypes: c.contractTypes,
  };
}

const ESCALATION_REASON: Record<Exclude<RagStatus, "grounded">, string> = {
  insufficient_evidence: "No policy passage supports an answer to this question with sufficient confidence.",
  no_applicable_policy: "No policy applies to this customer's tier and contract type.",
  retrieval_failed: "The knowledge base could not be searched.",
};

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    @Inject(EmbeddingService) private readonly embeddings: EmbeddingService,
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Inject(ConfidenceService) private readonly confidence: ConfidenceService,
    @Inject(EVIDENCE_VERIFIER) private readonly verifier: EvidenceVerifier,
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(RAG_CONFIG) private readonly config: RagConfig,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Retrieve grounded policy evidence. Never throws for expected failures: every outcome that is not
   * `grounded` comes back as a structured escalation-required result.
   */
  async search(request: RagSearchRequest & { topK: number }): Promise<RagSearchResponse> {
    return withSpan("rag.search", { category: "rag" }, async (span) => {
      const r = await this.searchInner(request);
      span.setAttr("status", r.status);
      span.setAttr("top_similarity", r.sources[0]?.similarity ?? r.rejected[0]?.similarity ?? 0);
      span.setAttr("evidence_verified", r.evidenceVerified);
      // What the retrieval inspector shows: query, filters, threshold, embedding model, every candidate and why it was kept or rejected.
      span.setDetail({
        query: request.query, topK: request.topK, filters: r.appliedFilters, threshold: r.threshold, embedding: r.providers, status: r.status,
        confidenceScore: r.confidenceScore, evidenceVerified: r.evidenceVerified, verification: r.verification, escalationReason: r.escalationReason, metrics: r.metrics, usage: r.usage,
        accepted: r.sources.map((s) => ({ chunkId: s.chunkId, document: s.document, heading: s.heading, policyVersion: s.policyVersion, similarity: s.similarity })),
        rejected: r.rejected.map((s) => ({ chunkId: s.chunkId, document: s.document, heading: s.heading, policyVersion: s.policyVersion, similarity: s.similarity })),
      });
      return r;
    });
  }

  private async searchInner(request: RagSearchRequest & { topK: number }): Promise<RagSearchResponse> {
    const started = performance.now();
    const filters: SearchFilters = {
      ...(request.tier ? { tier: request.tier } : {}),
      ...(request.contractType ? { contractType: request.contractType } : {}),
    };
    const metrics = { embeddingLatencyMs: 0, retrievalLatencyMs: 0, verificationLatencyMs: 0, totalLatencyMs: 0 };
    const usage = { embeddingTokens: 0, verificationInputTokens: 0, verificationOutputTokens: 0 };
    const base = {
      appliedFilters: filters,
      threshold: this.config.minSimilarity,
      providers: { embeddings: this.embeddings.provider, embeddingModel: this.embeddings.model },
    };
    const finish = (r: Omit<RagSearchResponse, "metrics" | "usage" | keyof typeof base>): RagSearchResponse => {
      metrics.totalLatencyMs = ms(started);
      return { ...base, ...r, metrics, usage };
    };
    const escalate = (
      status: Exclude<RagStatus, "grounded">,
      extra: Partial<Pick<RagSearchResponse, "confidenceScore" | "rejected" | "verification" | "sources">> = {},
    ) =>
      finish({
        status,
        confidenceScore: 0,
        evidenceVerified: false,
        requiresEscalation: true,
        escalationReason: ESCALATION_REASON[status],
        sources: [],
        rejected: [],
        ...extra,
      });

    try {
      if (this.env.SIMULATE_FAILURE === "retrieval") throw new Error("simulated retrieval failure");

      let t = performance.now();
      const { vector, tokens } = await withSpan("rag.embed_query", { category: "rag", attrs: { embedding_model: this.embeddings.model, provider: this.embeddings.provider } }, () => this.embeddings.embedQuery(request.query));
      metrics.embeddingLatencyMs = ms(t);
      usage.embeddingTokens = tokens;

      t = performance.now();
      const ranked = await withSpan("rag.vector_search", { category: "rag", attrs: { top_k: request.topK } }, () => this.retrieval.retrieve(vector, filters, request.topK));
      metrics.retrievalLatencyMs = ms(t);

      if (!ranked.length) return escalate("no_applicable_policy");

      const { confidenceScore, accepted, rejected } = this.confidence.assess(ranked);
      const rejectedSources = rejected.map(toSource);
      if (!accepted.length) {
        return escalate("insufficient_evidence", { confidenceScore: round(confidenceScore), rejected: rejectedSources });
      }

      t = performance.now();
      const verification = await withSpan("guardrail.evidence_verification", { category: "guardrail" }, () => this.verifier.verify({ query: request.query, filters, sources: accepted }));
      metrics.verificationLatencyMs = ms(t);
      usage.verificationInputTokens = verification.inputTokens;
      usage.verificationOutputTokens = verification.outputTokens;
      const verificationInfo = { method: verification.method, supported: verification.supported, reason: verification.reason };

      if (!verification.supported) {
        return escalate("insufficient_evidence", {
          confidenceScore: round(confidenceScore),
          rejected: [...accepted.map(toSource), ...rejectedSources],
          verification: verificationInfo,
        });
      }
      return finish({
        status: "grounded",
        confidenceScore: round(confidenceScore),
        evidenceVerified: true,
        requiresEscalation: false,
        sources: accepted.map(toSource),
        rejected: rejectedSources,
        verification: verificationInfo,
      });
    } catch (err) {
      this.logger.error(`retrieval failed: ${err instanceof Error ? err.message : String(err)}`);
      return escalate("retrieval_failed");
    }
  }

  async health(): Promise<RagHealth> {
    try {
      const stats = await this.store.stats();
      const ok = stats.pgvector && stats.chunks > 0;
      return {
        status: ok ? "ok" : "degraded",
        ...stats,
        embeddings: { provider: this.embeddings.provider, model: this.embeddings.model },
        verifier: this.config.verifier,
        threshold: this.config.minSimilarity,
      };
    } catch {
      return {
        status: "down", documents: 0, chunks: 0, pgvector: false,
        embeddings: { provider: this.embeddings.provider, model: this.embeddings.model },
        verifier: this.config.verifier, threshold: this.config.minSimilarity,
      };
    }
  }

  listDocuments() {
    return this.store.listDocuments();
  }
}
