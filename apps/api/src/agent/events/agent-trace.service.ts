import { Inject, Injectable, Logger } from "@nestjs/common";
import type pg from "pg";
import { PG_POOL } from "../../database/tokens.js";
import { redact } from "../../tools/registry/tool-executor.service.js";
import type { AgentRunMetrics } from "@support-ai/contracts";

export interface LlmCallTrace {
  runId: string;
  sessionId: string;
  purpose: string;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  decision?: string;
  errorCode?: string;
  /** Sanitized prompt text, stored only when TRACE_PROMPTS=true. */
  prompt?: string;
}

/** Observability records collected from the first day: model calls, retrieval evidence and run usage. */
@Injectable()
export class AgentTraceService {
  private readonly logger = new Logger(AgentTraceService.name);

  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async recordLlmCall(t: LlmCallTrace): Promise<void> {
    await this.safely("llm call", () =>
      this.pool.query(
        `insert into llm_calls (run_id, session_id, purpose, model, latency_ms, input_tokens, output_tokens, decision, error_code, prompt)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [t.runId, t.sessionId, t.purpose, t.model, t.latencyMs, t.inputTokens, t.outputTokens, t.decision ?? null, t.errorCode ?? null, t.prompt ?? null],
      ),
    );
  }

  async recordRetrieval(r: {
    runId: string; sessionId: string; toolCallId: string; query: string; verified: boolean;
    sources: Array<{ id: string; document: string; heading: string; similarity: number }>;
  }): Promise<void> {
    for (const s of r.sources) {
      await this.safely("retrieval result", () =>
        this.pool.query(
          `insert into retrieval_results (run_id, session_id, tool_call_id, query, chunk_id, document, heading, similarity, evidence_verified)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [r.runId, r.sessionId, r.toolCallId, r.query, s.id, s.document, s.heading, s.similarity, r.verified],
        ),
      );
    }
  }

  async saveUsage(runId: string, model: string, m: AgentRunMetrics, llmLatencyMs: number, embeddingTokens = 0): Promise<void> {
    await this.safely("usage", () =>
      this.pool.query(
        `insert into usage_metrics (run_id, model, input_tokens, output_tokens, embedding_tokens, est_cost_usd, total_latency_ms, llm_calls, tool_calls, iterations, llm_latency_ms)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (run_id) do update set model = excluded.model, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
           embedding_tokens = excluded.embedding_tokens, est_cost_usd = excluded.est_cost_usd, total_latency_ms = excluded.total_latency_ms,
           llm_calls = excluded.llm_calls, tool_calls = excluded.tool_calls, iterations = excluded.iterations, llm_latency_ms = excluded.llm_latency_ms`,
        [runId, model, m.inputTokens, m.outputTokens, embeddingTokens, m.estimatedCostUsd, m.durationMs, m.llmCalls, m.toolCalls, m.iterations, llmLatencyMs],
      ),
    );
  }

  /** Sanitized view of everything recorded for a run (for the admin-only trace endpoint). */
  async tracesForRun(runId: string) {
    const [events, llmCalls, retrieval, usage, pending] = await Promise.all([
      this.pool.query("select seq, type, data, created_at from trace_events where run_id = $1 order by seq", [runId]),
      this.pool.query("select id, purpose, model, latency_ms, input_tokens, output_tokens, decision, error_code, prompt, created_at from llm_calls where run_id = $1 order by id", [runId]),
      this.pool.query("select tool_call_id, query, chunk_id, document, heading, similarity, evidence_verified from retrieval_results where run_id = $1 order by id", [runId]),
      this.pool.query("select * from usage_metrics where run_id = $1", [runId]),
      this.pool.query("select id, type, tool, summary, status, expires_at, resolved_at from pending_actions where run_id = $1 order by created_at", [runId]),
    ]);
    const tools = await this.pool.query("select tool, status, error_code, attempts, duration_ms, args, created_at from tool_executions where run_id = $1 order by created_at", [runId]);
    return redact({ events: events.rows, llmCalls: llmCalls.rows, retrieval: retrieval.rows, usage: usage.rows[0] ?? null, pendingActions: pending.rows, toolExecutions: tools.rows });
  }

  private async safely(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // Observability must never break the run it observes.
      this.logger.error(`failed to record ${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
