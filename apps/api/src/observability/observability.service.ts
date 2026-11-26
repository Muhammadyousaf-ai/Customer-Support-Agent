import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type pg from "pg";
import { PG_POOL } from "../database/tokens.js";
import { classifyError } from "./errors/error-classifier.js";
import { telemetry } from "./persistence/telemetry-writer.js";
import { pricingRegistry } from "./pricing/pricing-registry.js";
import { sanitize } from "./privacy/telemetry-sanitizer.js";

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const round = (n: number, d = 2) => Number(n.toFixed(d));
const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : null);

export interface RunRef { runId: string; sessionId: string; mode: "chat" | "voice"; status: string; startedAt: Date; finishedAt: Date | null; voiceTurnId: string | null }

/**
 * Read side of observability. Everything is assembled from rows the earlier phases already write (trace_events,
 * tool_executions, retrieval_results, agent_runs, voice_*) plus the Phase 7 tables. `detail=false` is the owner view:
 * timings, counts and cost, but no prompts, tool arguments or results.
 */
@Injectable()
export class ObservabilityService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Telemetry is written asynchronously; flush first so a read right after an event sees it. */
  private async fresh(): Promise<void> {
    await telemetry()?.flush();
  }

  health() {
    return telemetry()?.status() ?? { degraded: false, queued: 0, dropped: 0, written: 0, failedBatches: 0, lastError: null, disabled: true };
  }

  async runRef(runId: string): Promise<RunRef> {
    const { rows } = await this.pool.query("select id, session_id, mode, status, started_at, finished_at, voice_turn_id from agent_runs where id = $1", [runId]);
    const r = rows[0];
    if (!r) throw new NotFoundException("Run not found.");
    return { runId: r.id, sessionId: r.session_id, mode: r.mode, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at, voiceTurnId: r.voice_turn_id };
  }

  async sessionOfVoice(voiceSessionId: string): Promise<string> {
    const { rows } = await this.pool.query("select session_id from voice_sessions where id = $1", [voiceSessionId]);
    if (!rows[0]) throw new NotFoundException("Voice session not found.");
    return rows[0].session_id;
  }

  // ---- history ----------------------------------------------------------------------------------------------------------
  async history(sessionId: string) {
    await this.fresh();
    const { rows } = await this.pool.query(
      `select r.id, r.mode, r.status, r.started_at, r.finished_at, r.voice_turn_id,
         (select left(m.content, 80) from messages m where m.run_id = r.id and m.role = 'user' order by m.id limit 1) as request,
         (select coalesce(sum(duration_ms),0) from trace_spans s where s.run_id = r.id and s.name = 'agent.run') as processing_ms,
         (select count(*) from model_invocations i where i.run_id = r.id) as model_calls,
         (select coalesce(sum((i.usage->>'totalTokens')::numeric),0) from model_invocations i where i.run_id = r.id) as tokens,
         (select coalesce(sum(i.estimated_cost_usd),0) from model_invocations i where i.run_id = r.id) as cost,
         (select count(*) from model_invocations i where i.run_id = r.id and i.cost_status <> 'ok') as unpriced,
         (select count(*) from tool_executions t where t.run_id = r.id) as tool_calls
       from agent_runs r where r.session_id = $1 order by r.started_at desc limit 100`, [sessionId],
    );
    return rows.map((r) => ({
      runId: r.id, mode: r.mode, status: r.status, startedAt: r.started_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null, request: r.request, voiceTurnId: r.voice_turn_id,
      processingMs: Math.round(num(r.processing_ms)), modelCalls: num(r.model_calls), toolCalls: num(r.tool_calls), tokens: num(r.tokens),
      estimatedCostUsd: num(r.model_calls) === 0 ? null : num(r.unpriced) > 0 ? null : num(r.cost).toFixed(6), costComplete: num(r.unpriced) === 0,
    }));
  }

  // ---- overview ---------------------------------------------------------------------------------------------------------
  async overview(runId: string) {
    await this.fresh();
    const ref = await this.runRef(runId);
    const [segments, events, usage, tools, rag, voice, firstModel] = await Promise.all([
      this.pool.query("select started_at, duration_ms, attributes from trace_spans where run_id = $1 and name = 'agent.run' order by started_at", [runId]),
      this.pool.query("select type, created_at, data from trace_events where run_id = $1 order by seq", [runId]),
      this.usage(runId),
      this.pool.query("select status, attempts from tool_executions where run_id = $1", [runId]),
      this.pool.query("select attributes from trace_spans where run_id = $1 and name = 'rag.search' order by started_at", [runId]),
      this.pool.query("select s.attributes, s.voice_session_id from trace_spans s where s.name = 'voice.turn' and s.run_id = $1 limit 1", [runId]),
      this.pool.query("select count(*) as n, coalesce(sum(duration_ms),0) as ms from model_invocations where run_id = $1", [runId]),
    ]);
    const segs = segments.rows;
    // Processing time = the sum of execution segments. The customer's thinking time at a confirmation is NOT processing.
    const processingMs = Math.round(segs.reduce((n, s) => n + num(s.duration_ms), 0));
    const first = segs[0] ? new Date(segs[0].started_at).getTime() : ref.startedAt.getTime();
    const lastEnd = segs.length ? Math.max(...segs.map((s) => new Date(s.started_at).getTime() + num(s.duration_ms))) : first;
    const wallMs = Math.max(0, Math.round(lastEnd - first));
    const ev = events.rows;
    const t0 = ref.startedAt.getTime();
    const firstStatus = ev.find((e) => ["decision.completed", "tool.started", "retrieval.completed"].includes(e.type));
    const firstText = ev.find((e) => e.type === "response.delta");
    const guardrailFailures = ev.filter((e) => e.type === "guardrail.failed").length;
    const toolRows = tools.rows;
    const ragAttrs = rag.rows.map((r) => r.attributes as { top_similarity?: number; evidence_verified?: boolean });
    const lastRag = ragAttrs[ragAttrs.length - 1];
    const v = voice.rows[0]?.attributes as { first_audio_ms?: number } | undefined;
    return {
      runId, sessionId: ref.sessionId, mode: ref.mode, status: ref.status, provider: "openai", traceId: (await this.traceIdOf(runId)),
      startedAt: ref.startedAt.toISOString(), finishedAt: ref.finishedAt?.toISOString() ?? null,
      metrics: {
        /** Sum of execution segments: how long the system actually worked. */
        endToEndProcessingMs: processingMs,
        wallClockMs: wallMs,
        /** Time between segments, i.e. the run waiting for the customer (confirmation). */
        customerWaitMs: Math.max(0, wallMs - processingMs),
        segments: segs.length,
        timeToFirstStatusMs: firstStatus ? Math.max(0, new Date(firstStatus.created_at).getTime() - t0) : null,
        userVisibleTtftMs: firstText ? Math.max(0, new Date(firstText.created_at).getTime() - t0) : null,
        modelTtftMs: null as number | null, // the model is called without streaming, so first-token time is not observable
        modelCalls: num(firstModel.rows[0]?.n), modelMs: Math.round(num(firstModel.rows[0]?.ms)),
        toolCalls: toolRows.length, toolFailures: toolRows.filter((t) => t.status === "failed").length,
        retries: toolRows.reduce((n, t) => n + Math.max(0, num(t.attempts) - 1), 0),
        retrievalAttempts: rag.rows.length, guardrailFailures,
        ...(v ? { timeToFirstAudioMs: v.first_audio_ms ?? null } : {}),
      },
      usage: usage.totals,
      grounding: lastRag ? { topSimilarity: lastRag.top_similarity ?? null, evidenceVerified: lastRag.evidence_verified ?? null } : null,
      voice: voice.rows[0] ? { voiceSessionId: voice.rows[0].voice_session_id as string } : null,
      observability: this.health(),
    };
  }

  private async traceIdOf(runId: string): Promise<string | null> {
    const { rows } = await this.pool.query("select trace_id from trace_spans where run_id = $1 limit 1", [runId]);
    return rows[0]?.trace_id ?? null;
  }

  // ---- spans, models, tools, retrievals, guardrails ------------------------------------------------------------------------
  async spans(runId: string, detail: boolean) {
    await this.fresh();
    const { rows } = await this.pool.query("select span_id, trace_id, parent_span_id, name, category, started_at, duration_ms, status, error_code, attributes, detail from trace_spans where run_id = $1 order by started_at, span_id", [runId]);
    const t0 = rows.length ? Math.min(...rows.map((r) => new Date(r.started_at).getTime())) : 0;
    const ids = new Set(rows.map((r) => r.span_id));
    return rows.map((r) => ({
      spanId: r.span_id, traceId: r.trace_id,
      // A parent that is not one of this run's spans (the synthetic trace root) makes this a root.
      parentSpanId: r.parent_span_id && ids.has(r.parent_span_id) ? r.parent_span_id : null,
      name: r.name, category: r.category, startOffsetMs: Math.round(new Date(r.started_at).getTime() - t0), startedAt: r.started_at.toISOString(), durationMs: num(r.duration_ms), status: r.status, errorCode: r.error_code,
      attributes: r.attributes, ...(detail ? { detail: r.detail } : {}),
    }));
  }

  async models(runId: string, detail: boolean) {
    await this.fresh();
    const { rows } = await this.pool.query("select * from model_invocations where run_id = $1 order by started_at", [runId]);
    return rows.map((r, i) => ({
      invocationId: r.id, index: i + 1, spanId: r.span_id, purpose: r.purpose, provider: r.provider, model: r.model, promptVersion: r.prompt_version, startedAt: r.started_at.toISOString(),
      durationMs: num(r.duration_ms), finishReason: r.finish_reason, status: r.status, errorCode: r.error_code, usage: r.usage, usageSource: r.usage_source,
      estimatedCostUsd: r.estimated_cost_usd === null ? null : Number(r.estimated_cost_usd).toFixed(6), costStatus: r.cost_status, costNote: r.cost_note, pricingVersion: r.pricing_version,
      ...(detail ? { systemPrompt: r.system_prompt, messages: r.messages, tools: r.tools, output: r.output } : { restricted: true }),
    }));
  }

  async tools(runId: string, detail: boolean) {
    await this.fresh();
    const [exec, spans] = await Promise.all([
      this.pool.query("select id, tool_call_id, tool, tool_type, args, result, status, error_code, attempts, duration_ms, idempotency_key, created_at from tool_executions where run_id = $1 order by created_at", [runId]),
      this.pool.query("select span_id, parent_span_id, attributes from trace_spans where run_id = $1 and category = 'tool'", [runId]),
    ]);
    const spanByExec = new Map(spans.rows.map((s) => [(s.attributes as { execution_id?: string }).execution_id, s]));
    // The model call that chose this tool is the decision span whose invocation preceded it.
    const inv = await this.pool.query("select id, started_at from model_invocations where run_id = $1 and purpose = 'decision' order by started_at", [runId]);
    return exec.rows.map((r) => {
      const err = r.error_code ? classifyError(r.error_code) : null;
      const sp = spanByExec.get(r.id);
      const chosenBy = [...inv.rows].reverse().find((i) => new Date(i.started_at).getTime() <= new Date(r.created_at).getTime());
      return {
        executionId: r.id, toolCallId: r.tool_call_id, tool: r.tool, type: r.tool_type, status: r.status, attempts: num(r.attempts), retries: Math.max(0, num(r.attempts) - 1), durationMs: num(r.duration_ms),
        errorCode: r.error_code, errorKind: err?.kind ?? null, idempotencyKey: r.idempotency_key ? "present" : null, startedAt: r.created_at.toISOString(), spanId: sp?.span_id ?? null, parentModelInvocation: chosenBy?.id ?? null,
        // Proof that a business action really ran: this record comes from the executor, not from anything the model said.
        committed: r.tool_type === "write" && r.status === "success",
        ...(detail ? { args: sanitize(r.args), result: sanitize(r.result, { maxString: 2000 }) } : { restricted: true }),
      };
    });
  }

  async retrievals(runId: string) {
    await this.fresh();
    const { rows } = await this.pool.query("select span_id, started_at, duration_ms, attributes, detail from trace_spans where run_id = $1 and name = 'rag.search' order by started_at", [runId]);
    const sub = await this.pool.query("select name, parent_span_id, duration_ms from trace_spans where run_id = $1 and name in ('rag.embed_query','rag.vector_search','guardrail.evidence_verification')", [runId]);
    return rows.map((r, i) => ({
      attempt: i + 1, spanId: r.span_id, startedAt: r.started_at.toISOString(), durationMs: num(r.duration_ms),
      stages: sub.rows.filter((s) => s.parent_span_id === r.span_id).map((s) => ({ name: s.name, durationMs: num(s.duration_ms) })),
      ...(r.detail ?? {}),
    }));
  }

  async guardrails(runId: string) {
    await this.fresh();
    const [events, nodes] = await Promise.all([
      this.pool.query("select seq, type, data, created_at from trace_events where run_id = $1 and type in ('guardrail.passed','guardrail.failed','escalation.created','confirmation.required','clarification.required') order by seq", [runId]),
      this.pool.query("select name, duration_ms, status, error_code, attributes from trace_spans where run_id = $1 and category = 'guardrail' and name like 'node.%' order by started_at", [runId]),
    ]);
    return {
      results: events.rows.map((e) => {
        const d = (e.data ?? {}) as Record<string, unknown>;
        const failed = e.type === "guardrail.failed";
        return { sequence: e.seq, at: e.created_at.toISOString(), event: e.type, guardrail: d.guardrail ?? e.type.split(".")[0], status: e.type === "guardrail.passed" ? "passed" : failed ? "failed" : "decision", reasonCode: d.reason ?? d.detail ?? null, action: d.action ?? null };
      }),
      nodes: nodes.rows.map((n) => ({ node: n.name.replace("node.", ""), durationMs: num(n.duration_ms), status: n.status })),
    };
  }

  // ---- usage and cost ------------------------------------------------------------------------------------------------------
  async usage(runId: string) {
    await this.fresh();
    const [inv, ragRows] = await Promise.all([
      this.pool.query("select model, purpose, usage, usage_source, estimated_cost_usd, cost_status, cost_note, pricing_version, duration_ms from model_invocations where run_id = $1 order by started_at", [runId]),
      this.pool.query("select detail from trace_spans where run_id = $1 and name = 'rag.search'", [runId]),
    ]);
    const embedTokens = ragRows.rows.reduce((n, r) => n + num((r.detail as { usage?: { embeddingTokens?: number } } | null)?.usage?.embeddingTokens), 0);
    const embeddingModel = (ragRows.rows[0]?.detail as { embedding?: { embeddingModel?: string; embeddings?: string } } | undefined)?.embedding;
    const byModel = new Map<string, { model: string; calls: number; inputTextTokens: number; outputTextTokens: number; cachedInputTokens: number; thinkingTokens: number; totalTokens: number; costUsd: number; unpriced: number; sources: Set<string> }>();
    let costComplete = true;
    for (const r of inv.rows) {
      const u = r.usage as Record<string, number>;
      const m = byModel.get(r.model) ?? { model: r.model, calls: 0, inputTextTokens: 0, outputTextTokens: 0, cachedInputTokens: 0, thinkingTokens: 0, totalTokens: 0, costUsd: 0, unpriced: 0, sources: new Set<string>() };
      m.calls += 1; m.inputTextTokens += num(u.inputTextTokens); m.outputTextTokens += num(u.outputTextTokens); m.cachedInputTokens += num(u.cachedInputTokens); m.thinkingTokens += num(u.thinkingTokens); m.totalTokens += num(u.totalTokens);
      m.sources.add(r.usage_source);
      if (r.cost_status === "ok") m.costUsd += num(r.estimated_cost_usd); else { m.unpriced += 1; costComplete = false; }
      byModel.set(r.model, m);
    }
    // Embedding cost: only when a priced embedding model produced the tokens (the local hash embedder is free and has no tokens to bill).
    let embeddingCost: { usd: number } | { unavailable: string } | null = null;
    if (embedTokens > 0 && embeddingModel) {
      const est = pricingRegistry.estimate((embeddingModel as { embeddingModel?: string }).embeddingModel ?? "", { inputTextTokens: 0, outputTextTokens: 0, inputAudioTokens: 0, outputAudioTokens: 0, cachedInputTokens: 0, thinkingTokens: 0, toolInputTokens: 0, totalTokens: 0, usageSource: "provider_reported" }, new Date(), { embeddingTokens: embedTokens });
      embeddingCost = est.status === "ok" ? { usd: est.usd } : { unavailable: est.reason };
      if (est.status !== "ok") costComplete = false;
    }
    const llmCost = [...byModel.values()].reduce((n, m) => n + m.costUsd, 0);
    const totalCost = llmCost + (embeddingCost && "usd" in embeddingCost ? embeddingCost.usd : 0);
    const totals = inv.rows.reduce((t, r) => { const u = r.usage as Record<string, number>; return { input: t.input + num(u.inputTextTokens) + num(u.cachedInputTokens), output: t.output + num(u.outputTextTokens), total: t.total + num(u.totalTokens) }; }, { input: 0, output: 0, total: 0 });
    return {
      models: [...byModel.values()].map((m) => ({ ...m, sources: [...m.sources], costUsd: m.unpriced ? null : m.costUsd.toFixed(6) })),
      embedding: { tokens: embedTokens, model: (embeddingModel as { embeddingModel?: string } | undefined)?.embeddingModel ?? null, cost: embeddingCost },
      totals: {
        inputTokens: totals.input, outputTokens: totals.output, totalTokens: totals.total, embeddingTokens: embedTokens, modelCalls: inv.rows.length,
        /** null = unavailable. Never shown as zero. */
        estimatedCostUsd: inv.rows.length === 0 ? null : costComplete ? totalCost.toFixed(6) : null,
        partialCostUsd: totalCost.toFixed(6), costComplete,
        costNotes: [...new Set(inv.rows.filter((r) => r.cost_note).map((r) => r.cost_note as string))],
        pricingVersions: [...new Set(inv.rows.map((r) => r.pricing_version).filter(Boolean))],
        label: "Estimated API cost. Excludes free-tier credits, discounts and taxes.",
      },
    };
  }

  async errors(runId: string) {
    await this.fresh();
    const [ev, tools, spans] = await Promise.all([
      this.pool.query("select category, kind, code, message, occurred_at, span_id from error_events where run_id = $1 order by occurred_at", [runId]),
      this.pool.query("select tool, error_code, attempts, created_at from tool_executions where run_id = $1 and attempts > 1 order by created_at", [runId]),
      this.pool.query("select name, status, error_code from trace_spans where run_id = $1 and name like 'tool.%' ", [runId]),
    ]);
    void spans;
    return {
      errors: ev.rows.map((e) => ({ category: e.category, kind: e.kind, code: e.code, message: e.message, at: e.occurred_at.toISOString(), spanId: e.span_id })),
      retries: tools.rows.map((t) => ({ tool: t.tool, attempts: num(t.attempts), finalErrorCode: t.error_code, at: t.created_at.toISOString(), recovered: !t.error_code })),
      summary: {
        infrastructure: ev.rows.filter((e) => e.kind === "infrastructure").length,
        businessRule: ev.rows.filter((e) => e.kind === "business_rule").length,
        guardrail: ev.rows.filter((e) => e.kind === "guardrail").length,
      },
    };
  }

  // ---- voice ------------------------------------------------------------------------------------------------------------------
  async voice(voiceSessionId: string) {
    await this.fresh();
    const [usage, turns, calls, spans, vs] = await Promise.all([
      this.pool.query("select * from voice_usage where voice_session_id = $1", [voiceSessionId]),
      this.pool.query("select id, run_id, interrupted, grounding_status, created_at, completed_at from voice_turns where voice_session_id = $1 order by created_at", [voiceSessionId]),
      this.pool.query("select status, duplicate_count from voice_function_calls where voice_session_id = $1", [voiceSessionId]),
      this.pool.query("select name, started_at, duration_ms, status, attributes from trace_spans where voice_session_id = $1 order by started_at", [voiceSessionId]),
      this.pool.query("select status, model, started_at, connected_at, ended_at, end_reason from voice_sessions where id = $1", [voiceSessionId]),
    ]);
    const m = (usage.rows[0]?.metrics ?? {}) as Record<string, unknown>;
    const turnSpans = spans.rows.filter((s) => s.name === "voice.turn");
    return {
      voiceSessionId, status: vs.rows[0]?.status ?? null, model: vs.rows[0]?.model ?? null, endReason: vs.rows[0]?.end_reason ?? null,
      metrics: m,
      cost: usage.rows[0] ? { estimatedCostUsd: usage.rows[0].estimated_cost_usd === null ? null : Number(usage.rows[0].estimated_cost_usd).toFixed(6), pricingVersion: usage.rows[0].pricing_effective_date ? `${usage.rows[0].pricing_model}@${usage.rows[0].pricing_effective_date}` : null,
        /** Provider usage for a Live session is cumulative and not reported per turn, so it is shown at session level only. */
        attribution: "session" } : null,
      audioSeconds: usage.rows[0] ? { input: round(num(usage.rows[0].audio_input_seconds)), output: round(num(usage.rows[0].audio_output_seconds)) } : null,
      turns: turns.rows.map((t) => ({ turnId: t.id, runId: t.run_id, interrupted: t.interrupted, grounding: t.grounding_status, firstAudioMs: (turnSpans.find((s) => s.attributes?.turn_id === t.id)?.attributes as { first_audio_ms?: number } | undefined)?.first_audio_ms ?? null })),
      functionCalls: { total: calls.rows.length, duplicates: calls.rows.reduce((n, c) => n + num(c.duplicate_count), 0) },
      events: spans.rows.filter((s) => s.name !== "voice.turn").map((s) => ({ name: s.name, at: s.started_at.toISOString(), durationMs: num(s.duration_ms), status: s.status, attributes: s.attributes })),
    };
  }

  // ---- pricing and aggregates -----------------------------------------------------------------------------------------------------
  pricing() {
    return { currency: "USD", unit: "per 1M tokens", entries: pricingRegistry.all(), note: "Models without an entry have no price: their cost is reported as unavailable." };
  }

  async summary(days = 7) {
    await this.fresh();
    const since = `now() - make_interval(days => ${Math.max(1, Math.min(90, Math.floor(days)))})`;
    const [runs, dur, inv, byDay, tools, err] = await Promise.all([
      this.pool.query(`select mode, status, count(*) n from agent_runs where started_at > ${since} group by mode, status`),
      this.pool.query(`select r.id, coalesce(sum(s.duration_ms),0) ms from agent_runs r left join trace_spans s on s.run_id = r.id and s.name = 'agent.run' where r.started_at > ${since} group by r.id`),
      this.pool.query(`select count(*) calls, count(*) filter (where status = 'error') failed, coalesce(sum(estimated_cost_usd),0) cost, count(*) filter (where cost_status <> 'ok') unpriced from model_invocations where started_at > ${since}`),
      this.pool.query(`select date_trunc('day', i.started_at) d, coalesce(r.mode,'chat') mode, sum(i.estimated_cost_usd) cost from model_invocations i left join agent_runs r on r.id = i.run_id where i.started_at > ${since} group by 1,2 order by 1`),
      this.pool.query(`select count(*) total, count(*) filter (where status = 'failed') failed from tool_executions where created_at > ${since}`),
      this.pool.query(`select kind, count(*) n from error_events where occurred_at > ${since} group by kind`),
    ]);
    const total = runs.rows.reduce((n, r) => n + num(r.n), 0);
    const by = (f: (r: { mode: string; status: string }) => boolean) => runs.rows.filter(f).reduce((n, r) => n + num(r.n), 0);
    const lat = dur.rows.map((r) => num(r.ms)).filter((n) => n > 0).sort((a, b) => a - b);
    const i = inv.rows[0] ?? {};
    return {
      days, totalInteractions: total, chat: by((r) => r.mode === "chat"), voice: by((r) => r.mode === "voice"),
      /** "Resolved" is an agent outcome (completed), not just the absence of an exception; real resolution quality needs evaluation. */
      completed: by((r) => r.status === "completed"), escalated: by((r) => r.status === "escalated"), failed: by((r) => r.status === "failed"),
      escalationRate: total ? round(by((r) => r.status === "escalated") / total, 3) : null,
      medianLatencyMs: pct(lat, 50), p95LatencyMs: pct(lat, 95),
      modelCalls: num(i.calls), providerErrorRate: num(i.calls) ? round(num(i.failed) / num(i.calls), 3) : null,
      toolFailureRate: num(tools.rows[0]?.total) ? round(num(tools.rows[0].failed) / num(tools.rows[0].total), 3) : null,
      guardrailRejections: num(err.rows.find((r) => r.kind === "guardrail")?.n),
      estimatedCostUsd: num(i.unpriced) > 0 ? null : num(i.cost).toFixed(6), partialCostUsd: num(i.cost).toFixed(6), unpricedCalls: num(i.unpriced),
      avgModelCallsPerRun: total ? round(num(i.calls) / total, 2) : null,
      avgCostPerInteractionUsd: total && num(i.unpriced) === 0 ? (num(i.cost) / total).toFixed(6) : null,
      dailyCost: byDay.rows.map((r) => ({ day: r.d.toISOString().slice(0, 10), mode: r.mode, costUsd: r.cost === null ? null : Number(r.cost).toFixed(6) })),
      observability: this.health(),
    };
  }
}
