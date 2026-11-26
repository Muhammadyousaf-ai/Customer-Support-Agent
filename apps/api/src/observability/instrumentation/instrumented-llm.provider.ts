import { createHash, randomUUID } from "node:crypto";
import { trace } from "@opentelemetry/api";
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from "../../agent/providers/llm-provider.interface.js";
import { currentTrace } from "../context/telemetry-context.js";
import { moduleLogger } from "../logging/logger.js";
import { telemetry } from "../persistence/telemetry-writer.js";
import { formatUsd, pricingRegistry } from "../pricing/pricing-registry.js";
import { sanitize, sanitizeString } from "../privacy/telemetry-sanitizer.js";
import { estimateTokens, normalizeUsage, type NormalizedUsage } from "../usage/usage-normalizer.js";
import { withSpan } from "../tracing/tracing.js";

const log = moduleLogger("llm");

/** Short, stable id of the exact system prompt text: two calls with the same version used the same instructions. */
export const promptVersion = (system: string): string => `sha256:${createHash("sha256").update(system).digest("hex").slice(0, 12)}`;

/**
 * Wraps the configured model provider so EVERY model call (decision, evidence check, conversation summary) is traced,
 * sanitized, priced and persisted in one place, instead of each call site doing its own bookkeeping. Behaviour is
 * unchanged: the response and any error pass straight through.
 */
export class InstrumentedLlmProvider implements LlmProvider {
  constructor(private readonly inner: LlmProvider, private readonly provider = "openai") {}

  get name() { return this.inner.name; }
  get model() { return this.inner.model; }
  get configured() { return this.inner.configured; }

  complete(req: LlmRequest): Promise<LlmResponse> {
    const ctx = currentTrace();
    const id = `inv_${randomUUID()}`;
    const startedAt = new Date();
    return withSpan(`llm.${req.purpose}`, { category: "llm", attrs: { model: this.inner.model, purpose: req.purpose, invocation_id: id } }, async (span) => {
      let res: LlmResponse | null = null;
      let error: unknown;
      try {
        res = await this.inner.complete(req);
        return res;
      } catch (err) {
        error = err;
        throw err;
      } finally {
        try {
          const usage = this.usageOf(req, res);
          const cost = pricingRegistry.estimate(res?.model ?? this.inner.model, usage, startedAt);
          const sc = trace.getActiveSpan()?.spanContext();
          const errorCode = error ? (error instanceof LlmError ? error.code : "LLM_UNAVAILABLE") : null;
          span.setAttr("tokens_total", usage.totalTokens);
          span.setAttr("usage_source", usage.usageSource);
          if (cost.status === "ok") span.setAttr("cost_usd", formatUsd(cost.usd));
          span.setDetail({ purpose: req.purpose, model: res?.model ?? this.inner.model, finishReason: res?.finishReason, toolCalls: res?.toolCalls.map((c) => c.name) });
          telemetry()?.enqueue({
            t: "invocation",
            row: {
              id, runId: ctx?.runId ?? null, sessionId: ctx?.sessionId ?? null, traceId: sc?.traceId ?? ctx?.traceId ?? null, spanId: sc?.spanId ?? null,
              purpose: req.purpose, provider: this.provider, model: res?.model ?? this.inner.model, promptVersion: promptVersion(req.system), startedAt,
              durationMs: res?.latencyMs ?? Date.now() - startedAt.getTime(), finishReason: res?.finishReason ?? null, status: error ? "error" : "ok", errorCode,
              usage, usageSource: usage.usageSource,
              estimatedCostUsd: cost.status === "ok" ? formatUsd(cost.usd) : null, costStatus: cost.status, costNote: cost.status === "ok" ? null : cost.reason,
              pricingVersion: cost.status === "ok" ? cost.pricingVersion : null, pricingSnapshot: cost.status === "ok" ? cost.snapshot : null,
              // The actual application inputs and observable outputs. Not the model's private reasoning.
              systemPrompt: sanitizeString(req.system, 20_000),
              messages: sanitize(req.messages.map((m) => ({ role: m.role, content: m.content, toolCalls: m.toolCalls?.map((c) => ({ name: c.name, arguments: c.arguments })), toolCallId: m.toolCallId })), { maxString: 6000, maxItems: 60 }),
              tools: req.tools.map((t) => ({ name: t.name, description: sanitizeString(t.description, 400) })),
              output: res ? sanitize({ content: res.content, toolCalls: res.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })) }, { maxString: 6000 }) : error ? { error: errorCode } : null,
            },
          });
          log.info({ event: "model.invocation", traceId: sc?.traceId, runId: ctx?.runId, sessionId: ctx?.sessionId, model: this.inner.model, purpose: req.purpose, tokens: usage.totalTokens, usageSource: usage.usageSource, errorCode }, "model call");
        } catch (err) {
          log.error({ err: err instanceof Error ? err.message : String(err) }, "model call instrumentation failed");
        }
      }
    });
  }

  /** Provider-reported usage when present; otherwise a labelled estimate; for a failed call with nothing to go on, unavailable. */
  private usageOf(req: LlmRequest, res: LlmResponse | null): NormalizedUsage {
    if (res && res.usageReported !== false) {
      return normalizeUsage({ promptTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, cachedTokens: res.cachedTokens, thinkingTokens: res.reasoningTokens, thinkingIncludedInOutput: true });
    }
    if (!res) return normalizeUsage(null, "unavailable");
    const promptChars = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0);
    const outChars = (res.content?.length ?? 0) + res.toolCalls.reduce((n, c) => n + c.arguments.length + c.name.length, 0);
    return normalizeUsage({ promptTokens: estimateTokens(promptChars), outputTokens: estimateTokens(outChars) }, "estimated");
  }
}
