import { contentTokens } from "../text/text-utils.js";
import type { EvidenceVerifier, RetrievedChunk, SearchFilters, VerificationResult } from "../types/rag.types.js";

/** Share of the question's content terms that must appear in the evidence. Starting value; tune with the eval set. */
export const MIN_TERM_COVERAGE = 0.34;

/**
 * Offline secondary check: do the retrieved passages actually mention what the question is about?
 * Catches queries that land near a policy by embedding accident but share no real subject matter.
 */
export class HeuristicEvidenceVerifier implements EvidenceVerifier {
  async verify(input: { query: string; filters: SearchFilters; sources: RetrievedChunk[] }): Promise<VerificationResult> {
    const queryTerms = [...new Set(contentTokens(input.query))];
    const evidence = new Set(input.sources.flatMap((s) => contentTokens(`${s.documentTitle} ${s.heading} ${s.content}`)));
    if (!queryTerms.length) {
      return { method: "heuristic", supported: false, reason: "query has no content terms", inputTokens: 0, outputTokens: 0 };
    }
    const matched = queryTerms.filter((t) => evidence.has(t));
    const coverage = matched.length / queryTerms.length;
    const supported = coverage >= MIN_TERM_COVERAGE;
    return {
      method: "heuristic",
      supported,
      reason: `${matched.length}/${queryTerms.length} query terms found in evidence (${coverage.toFixed(2)}, need ${MIN_TERM_COVERAGE})`,
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}
