import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Inject, Injectable } from "@nestjs/common";
import type { ToolResult } from "@support-ai/contracts";
import { z } from "zod";
import { classifyError } from "../../observability/errors/error-classifier.js";
import { withSpan } from "../../observability/tracing/tracing.js";
import { ToolError, toErrorInfo } from "../errors/tool-error.js";
import { ToolEventsService } from "../events/tool-events.service.js";
import { AuthorizationService } from "../middleware/authorization.service.js";
import { IdempotencyService } from "../middleware/idempotency.service.js";
import { RetryService } from "../middleware/retry.service.js";
import { TimeoutService } from "../middleware/timeout.service.js";
import { FailureSimulator } from "../simulation/failure-simulator.service.js";
import {
  EXECUTION_LOG, TOOL_CONTEXT_BUILDER, TOOL_RUNTIME_CONFIG,
  type ExecutionLog, type ToolCall, type ToolContextBuilder, type ToolDefinition, type ToolExecutionContext, type ToolRuntimeConfig,
} from "./tool-definition.interface.js";
import { ToolRegistry } from "./tool-registry.service.js";

const SECRET_KEYS = new Set(["verificationcode", "code", "password", "otp"]);

/** Whitelisted, UI-safe fields of completed write actions. The frontend renders result cards from these, never from model text. */
function resultSummary(tool: string, data: unknown): Record<string, string | number | boolean | null> | undefined {
  const d = (data ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => Object.fromEntries(keys.filter((k) => ["string", "number", "boolean"].includes(typeof d[k]) || d[k] === null).map((k) => [k, d[k] as string | number | boolean | null]));
  if (tool === "issue_refund") return pick("refundId", "paymentId", "amountCents", "amount", "currency", "status", "simulated");
  if (tool === "create_escalation_ticket") return pick("ticketId", "category", "priority", "reason", "status");
  if (tool === "update_account") return pick("field", "changed");
  return undefined;
}

/** Strips secrets before arguments are persisted in tool_executions. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.has(k.toLowerCase()) ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

/**
 * The one entry point for running a tool. Same lifecycle for every tool:
 * started event -> trusted context -> schema validation -> authorization -> idempotency key
 * -> (timeout + simulator + execute) with bounded retry -> persist -> completed/failed event.
 * Never throws: every outcome is a structured ToolResult.
 */
@Injectable()
export class ToolExecutor {
  constructor(
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(TOOL_CONTEXT_BUILDER) private readonly contexts: ToolContextBuilder,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(TimeoutService) private readonly timeout: TimeoutService,
    @Inject(RetryService) private readonly retry: RetryService,
    @Inject(ToolEventsService) private readonly events: ToolEventsService,
    @Inject(FailureSimulator) private readonly simulator: FailureSimulator,
    @Inject(EXECUTION_LOG) private readonly log: ExecutionLog,
    @Inject(TOOL_RUNTIME_CONFIG) private readonly config: ToolRuntimeConfig,
  ) {}

  async execute(call: ToolCall): Promise<ToolResult<unknown>> {
    return withSpan(`tool.${call.tool}`, { category: "tool", attrs: { tool: call.tool, tool_call_id: call.toolCallId } }, async (span) => {
      const result = await this.executeInner(call);
      const md = result.metadata;
      span.setAttr("execution_id", md?.executionId);
      span.setAttr("attempts", md?.attempts);
      span.setAttr("retries", Math.max(0, (md?.attempts ?? 1) - 1));
      span.setAttr("success", result.success);
      if (!result.success && result.error) {
        // A correctly rejected business action is the guardrails working: record the code, do not mark the span failed.
        if (classifyError(result.error.code).kind === "business_rule") span.setAttr("error_code", result.error.code);
        else span.setError(result.error.code, result.error.message);
      }
      return result;
    });
  }

  private async executeInner(call: ToolCall): Promise<ToolResult<unknown>> {
    const started = performance.now();
    const executionId = randomUUID();
    const executedAt = new Date().toISOString();
    const tool = this.registry.find(call.tool);
    const base = { tool: call.tool, toolCallId: call.toolCallId, executionId };
    this.events.emit("tool.started", call.sessionId, call.runId, { ...base, attempt: 1 });

    let attempts = 1;
    let idempotencyKey: string | undefined;
    let outcome: Pick<ToolResult<unknown>, "success" | "data" | "error">;
    try {
      if (!tool) throw new ToolError("TOOL_NOT_FOUND", `Unknown tool "${call.tool}".`);
      const ctx = await this.contexts.build(call);
      const parsed = tool.inputSchema.safeParse(call.input);
      if (!parsed.success) throw new ToolError("INVALID_ARGUMENTS", z.prettifyError(parsed.error));
      this.authorization.authorize(tool, ctx);
      if (tool.type === "write") {
        idempotencyKey = this.idempotency.keyFor(call, tool.name, parsed.data);
        ctx.idempotencyKey = idempotencyKey;
      }
      const run = await this.retry.run((n) => {
        attempts = n;
        if (n > 1) this.events.emit("tool.started", call.sessionId, call.runId, { ...base, attempt: n });
        return this.attempt(tool, parsed.data, ctx);
      }, { maxRetries: tool.maxRetries, baseDelayMs: this.config.retryBaseDelayMs });
      outcome = run.result;
    } catch (err) {
      outcome = { success: false, error: toErrorInfo(err) };
    }

    const durationMs = Math.round(performance.now() - started);
    const result: ToolResult<unknown> = {
      success: outcome.success,
      ...(outcome.success ? { data: outcome.data } : { error: outcome.error }),
      metadata: { executionId, durationMs, executedAt, attempts },
    };
    await this.log.record({
      executionId, runId: call.runId, sessionId: call.sessionId, toolCallId: call.toolCallId, tool: call.tool,
      toolType: tool?.type, args: redact(call.input), result: result.success ? result.data : result.error,
      status: result.success ? "success" : "failed", errorCode: result.error?.code, attempts, durationMs, idempotencyKey,
    });
    this.events.emit(result.success ? "tool.completed" : "tool.failed", call.sessionId, call.runId, {
      ...base, status: result.success ? "success" : "failed", durationMs, attempt: attempts, errorCode: result.error?.code,
      ...(result.success && resultSummary(call.tool, result.data) ? { result: resultSummary(call.tool, result.data) } : {}),
    });
    return result;
  }

  private async attempt(tool: ToolDefinition, input: unknown, ctx: ToolExecutionContext): Promise<ToolResult<unknown>> {
    try {
      return await this.timeout.run(this.config.timeoutOverrideMs ?? tool.timeoutMs, async (signal) => {
        await this.simulator.beforeExecute(tool.name, signal);
        const result = await tool.execute(input, { ...ctx, signal });
        await this.simulator.afterExecute(tool.name, signal);
        return result;
      });
    } catch (err) {
      return { success: false, error: toErrorInfo(err), metadata: { executionId: "", durationMs: 0, executedAt: "", attempts: 1 } };
    }
  }
}
