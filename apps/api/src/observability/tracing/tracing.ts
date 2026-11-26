import { randomBytes } from "node:crypto";
import { ROOT_CONTEXT, SpanStatusCode, context, trace, type Context, type Span } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { currentTrace, traceIdFor } from "../context/telemetry-context.js";
import { classifyError } from "../errors/error-classifier.js";
import { moduleLogger } from "../logging/logger.js";
import { telemetry } from "../persistence/telemetry-writer.js";
import { sanitize, sanitizeDetail } from "../privacy/telemetry-sanitizer.js";

export type SpanCategory = "agent" | "llm" | "tool" | "rag" | "guardrail" | "voice" | "db";
const log = moduleLogger("tracing");
const TRACER = "support-ai";

const hrToMs = (t: [number, number]) => t[0] * 1000 + t[1] / 1e6;
const hex16 = () => randomBytes(8).toString("hex");

/** Turns finished OpenTelemetry spans into rows for the telemetry writer. Never throws into the instrumented code. */
class PersistingProcessor implements SpanProcessor {
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    try {
      const w = telemetry();
      if (!w) return;
      const a = span.attributes;
      const errorCode = typeof a["support.error_code"] === "string" ? a["support.error_code"] : null;
      const failed = span.status.code === SpanStatusCode.ERROR;
      const detailRaw = a["support.detail"];
      let detail: unknown;
      if (typeof detailRaw === "string") { try { detail = JSON.parse(detailRaw); } catch { detail = undefined; } }
      const attributes: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a)) if (k.startsWith("support.") && k !== "support.detail" && k !== "support.category") attributes[k.slice(8)] = v;
      const sc = span.spanContext();
      const startedAt = new Date(hrToMs(span.startTime));
      const row = {
        spanId: sc.spanId, traceId: sc.traceId, parentSpanId: span.parentSpanContext?.spanId ?? null,
        runId: typeof a["support.run_id"] === "string" ? a["support.run_id"] : null, sessionId: typeof a["support.session_id"] === "string" ? a["support.session_id"] : null,
        voiceSessionId: typeof a["support.voice_session_id"] === "string" ? a["support.voice_session_id"] : null,
        name: span.name, category: String(a["support.category"] ?? "agent"), startedAt, durationMs: Math.round(hrToMs(span.duration) * 100) / 100,
        status: failed ? ("error" as const) : ("ok" as const), errorCode, attributes, detail,
      };
      w.enqueue({ t: "span", row });
      if (failed || errorCode) {
        const { category, kind } = classifyError(errorCode ?? undefined, span.status.message);
        w.enqueue({ t: "error", row: { traceId: row.traceId, spanId: row.spanId, runId: row.runId, sessionId: row.sessionId, category, kind, code: errorCode, message: span.status.message ? String(sanitize(span.status.message, { maxString: 300 })) : null, occurredAt: startedAt } });
        log.warn({ event: "span.failed", span: span.name, traceId: row.traceId, runId: row.runId, sessionId: row.sessionId, errorCode, kind }, "span failed");
      }
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "span processing failed");
    }
  }
  async forceFlush(): Promise<void> { await telemetry()?.flush(); }
  async shutdown(): Promise<void> { await telemetry()?.flush(); }
}

let provider: BasicTracerProvider | null = null;

/** Registers the OpenTelemetry SDK once per process. Before this runs (and in unit tests) every span call is a no-op. */
export function ensureTracing(): void {
  if (provider) return;
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  provider = new BasicTracerProvider({ spanProcessors: [new PersistingProcessor()] });
  trace.setGlobalTracerProvider(provider);
}

export interface SpanHandle {
  setAttr(key: string, value: string | number | boolean | undefined): void;
  /** Sanitized inputs/outputs shown by the span inspector. */
  setDetail(value: unknown): void;
  setError(code: string, message?: string): void;
}

function handle(span: Span): SpanHandle {
  return {
    setAttr: (k, v) => { if (v !== undefined) span.setAttribute(`support.${k}`, v); },
    setDetail: (v) => { try { span.setAttribute("support.detail", JSON.stringify(sanitizeDetail(v))); } catch { /* unserializable detail is dropped */ } },
    setError: (code, message) => { span.setAttribute("support.error_code", code); span.setStatus({ code: SpanStatusCode.ERROR, ...(message ? { message } : {}) }); },
  };
}

function stamp(span: Span, category: SpanCategory, attrs: Record<string, string | number | boolean | undefined> = {}) {
  const t = currentTrace();
  span.setAttribute("support.category", category);
  if (t) {
    span.setAttribute("support.run_id", t.runId);
    span.setAttribute("support.session_id", t.sessionId);
    span.setAttribute("support.mode", t.mode);
    span.setAttribute("support.segment", t.segment);
    if (t.voiceSessionId) span.setAttribute("support.voice_session_id", t.voiceSessionId);
  }
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) span.setAttribute(`support.${k}`, v);
}

/**
 * Runs `fn` inside a span that is a child of whatever span is active. An exception marks the span failed (with a
 * sanitized message, never a stack) and is rethrown unchanged: instrumentation must not alter behaviour.
 */
export function withSpan<T>(name: string, o: { category: SpanCategory; attrs?: Record<string, string | number | boolean | undefined> }, fn: (s: SpanHandle) => Promise<T>): Promise<T> {
  return trace.getTracer(TRACER).startActiveSpan(name, async (span) => {
    stamp(span, o.category, o.attrs);
    const h = handle(span);
    try {
      return await fn(h);
    } catch (err) {
      // LangGraph signals a confirmation pause by throwing; that is control flow, not a failure.
      if (typeof (err as Error)?.name === "string" && /^Graph(Interrupt|Bubble)/.test((err as Error).name)) { h.setAttr("paused", true); throw err; }
      const code = (err as { code?: unknown })?.code;
      h.setError(typeof code === "string" ? code : "EXCEPTION", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Context in which the next root span joins the trace of `key` (a run id, or a voice session id). */
export function traceContextFor(key: string): Context {
  return trace.setSpanContext(ROOT_CONTEXT, { traceId: traceIdFor(key), spanId: hex16(), traceFlags: 1, isRemote: true });
}

/** Runs `fn` with `key`'s trace as the active parent: every span created inside joins that trace. */
export function inTrace<T>(key: string, fn: () => T): T {
  return context.with(traceContextFor(key), fn);
}

/** Records a span that already happened (for example from a measured interval). */
export function recordSpan(o: {
  name: string; category: SpanCategory; traceKey: string; start: number; end: number; ok?: boolean; errorCode?: string;
  attrs?: Record<string, string | number | boolean | undefined>; detail?: unknown; sessionId?: string; runId?: string; voiceSessionId?: string;
}): void {
  const tracer = trace.getTracer(TRACER);
  const span = tracer.startSpan(o.name, { startTime: o.start }, traceContextFor(o.traceKey));
  span.setAttribute("support.category", o.category);
  if (o.sessionId) span.setAttribute("support.session_id", o.sessionId);
  if (o.runId) span.setAttribute("support.run_id", o.runId);
  if (o.voiceSessionId) span.setAttribute("support.voice_session_id", o.voiceSessionId);
  for (const [k, v] of Object.entries(o.attrs ?? {})) if (v !== undefined) span.setAttribute(`support.${k}`, v);
  if (o.detail !== undefined) handle(span).setDetail(o.detail);
  if (o.ok === false) handle(span).setError(o.errorCode ?? "EXCEPTION");
  span.end(o.end);
}
