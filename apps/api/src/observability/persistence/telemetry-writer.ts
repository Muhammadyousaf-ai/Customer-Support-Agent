import { moduleLogger } from "../logging/logger.js";
import type pg from "pg";

export interface SpanRow {
  spanId: string; traceId: string; parentSpanId: string | null; runId: string | null; sessionId: string | null; voiceSessionId: string | null;
  name: string; category: string; startedAt: Date; durationMs: number; status: "ok" | "error"; errorCode: string | null;
  attributes: Record<string, unknown>; detail: unknown;
}
export interface InvocationRow {
  id: string; runId: string | null; sessionId: string | null; traceId: string | null; spanId: string | null; purpose: string; provider: string; model: string;
  promptVersion: string | null; startedAt: Date; durationMs: number; finishReason: string | null; status: "ok" | "error"; errorCode: string | null;
  usage: unknown; usageSource: string; estimatedCostUsd: string | null; costStatus: "ok" | "unavailable"; costNote: string | null; pricingVersion: string | null;
  pricingSnapshot: unknown; systemPrompt: string | null; messages: unknown; tools: unknown; output: unknown;
}
export interface ErrorRow { traceId: string | null; spanId: string | null; runId: string | null; sessionId: string | null; category: string; kind: string; code: string | null; message: string | null; occurredAt: Date }

type Item = { t: "span"; row: SpanRow } | { t: "invocation"; row: InvocationRow } | { t: "error"; row: ErrorRow };
const log = moduleLogger("telemetry");

/**
 * Bounded, asynchronous, in-process batching writer. It sits OFF the request path: callers enqueue and return. When the
 * queue is full the newest diagnostic items are dropped and counted; when the database fails the writer reports
 * degraded observability and keeps serving. Business audit records and resumable workflow state never go through here.
 */
export class TelemetryWriter {
  private queue: Item[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  dropped = 0;
  written = 0;
  failedBatches = 0;
  lastError: string | null = null;
  lastErrorAt: number | null = null;

  constructor(private readonly pool: pg.Pool, private readonly opts: { maxQueue: number; flushMs: number; batch?: number } = { maxQueue: 5000, flushMs: 200 }) {}

  start(): void {
    this.timer ??= setInterval(() => void this.flush(), this.opts.flushMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  enqueue(item: Item): void {
    if (this.queue.length >= this.opts.maxQueue) {
      this.dropped += 1;
      return;
    }
    this.queue.push(item);
  }

  get queued(): number { return this.queue.length; }
  /** True while recent writes are failing. Cleared by the next successful batch. */
  get degraded(): boolean { return this.lastErrorAt !== null && this.failedBatches > 0; }
  status() {
    return { degraded: this.degraded, queued: this.queue.length, dropped: this.dropped, written: this.written, failedBatches: this.failedBatches, lastError: this.lastError };
  }

  /** Waits until everything queued before this call has been written (or failed). Used before reads and on shutdown. */
  async flush(): Promise<void> {
    for (;;) {
      if (this.flushing) {
        await this.flushing;
        continue;
      }
      if (!this.queue.length) return;
      this.flushing = this.drain().finally(() => { this.flushing = null; });
      await this.flushing;
    }
  }

  private async drain(): Promise<void> {
    const batch = this.queue.splice(0, this.opts.batch ?? 200);
    if (!batch.length) return;
    const client = await this.pool.connect().catch((err: unknown) => { this.fail(err, batch.length); return null; });
    if (!client) return;
    try {
      await client.query("begin");
      for (const it of batch) await this.insert(client, it);
      await client.query("commit");
      this.written += batch.length;
      this.failedBatches = 0;
      this.lastError = null;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      this.fail(err, batch.length);
    } finally {
      client.release();
    }
  }

  private fail(err: unknown, lost: number): void {
    this.failedBatches += 1;
    this.dropped += lost; // a failed batch is not retried forever: diagnostics must not pile up behind a broken database
    this.lastError = err instanceof Error ? err.message.slice(0, 300) : String(err);
    this.lastErrorAt = Date.now();
    log.error({ event: "telemetry.write_failed", lost, error: this.lastError }, "telemetry write failed; observability is degraded");
  }

  private async insert(c: pg.PoolClient, it: Item): Promise<void> {
    if (it.t === "span") {
      const r = it.row;
      await c.query(
        `insert into trace_spans (span_id, trace_id, parent_span_id, run_id, session_id, voice_session_id, name, category, started_at, duration_ms, status, error_code, attributes, detail)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb) on conflict (span_id) do nothing`,
        [r.spanId, r.traceId, r.parentSpanId, r.runId, r.sessionId, r.voiceSessionId, r.name, r.category, r.startedAt, r.durationMs, r.status, r.errorCode, JSON.stringify(r.attributes), r.detail === undefined ? null : JSON.stringify(r.detail)],
      );
    } else if (it.t === "invocation") {
      const r = it.row;
      await c.query(
        `insert into model_invocations (id, run_id, session_id, trace_id, span_id, purpose, provider, model, prompt_version, started_at, duration_ms, finish_reason, status, error_code, usage, usage_source,
           estimated_cost_usd, cost_status, cost_note, pricing_version, pricing_snapshot, system_prompt, messages, tools, output)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21::jsonb,$22,$23::jsonb,$24::jsonb,$25::jsonb) on conflict (id) do nothing`,
        [r.id, r.runId, r.sessionId, r.traceId, r.spanId, r.purpose, r.provider, r.model, r.promptVersion, r.startedAt, r.durationMs, r.finishReason, r.status, r.errorCode, JSON.stringify(r.usage), r.usageSource,
          r.estimatedCostUsd, r.costStatus, r.costNote, r.pricingVersion, JSON.stringify(r.pricingSnapshot ?? null), r.systemPrompt, JSON.stringify(r.messages ?? null), JSON.stringify(r.tools ?? null), JSON.stringify(r.output ?? null)],
      );
    } else {
      const r = it.row;
      await c.query("insert into error_events (trace_id, span_id, run_id, session_id, category, kind, code, message, occurred_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [r.traceId, r.spanId, r.runId, r.sessionId, r.category, r.kind, r.code, r.message, r.occurredAt]);
    }
  }

  /** Deletes diagnostic rows past the retention window. Returns how many rows were removed. */
  async purge(retentionDays: number): Promise<number> {
    let total = 0;
    for (const [table, col] of [["trace_spans", "created_at"], ["model_invocations", "created_at"], ["error_events", "occurred_at"], ["llm_calls", "created_at"]] as const) {
      const r = await this.pool.query(`delete from ${table} where ${col} < now() - make_interval(days => $1)`, [retentionDays]).catch(() => null);
      total += r?.rowCount ?? 0;
    }
    return total;
  }
}

/** The active writer (set once by ObservabilityModule). Instrumentation is a no-op when none is registered, e.g. in unit tests. */
let active: TelemetryWriter | null = null;
export const setTelemetryWriter = (w: TelemetryWriter | null): void => { active = w; };
export const telemetry = (): TelemetryWriter | null => active;
