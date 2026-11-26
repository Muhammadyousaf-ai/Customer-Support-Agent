import { Controller, Get, HttpException, HttpStatus, Inject, UseGuards } from "@nestjs/common";
import type { HealthResponse } from "@support-ai/contracts";
import { BudgetService } from "../../budget/budget.service.js";
import type { Env } from "../../config/env.js";
import { ENV } from "../../config/tokens.js";
import { pool } from "../../database/pool.js";
import { lifecycle } from "../../lifecycle/lifecycle-state.js";
import { telemetry } from "../../observability/persistence/telemetry-writer.js";
import { AdminGuard } from "../../rag/admin.guard.js";

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

/**
 * Liveness answers "is the process up" and does no I/O. Readiness answers "should traffic be sent here": the database must
 * answer and the process must not be draining. Neither calls OpenAI: a paid generation per health check would cost money and
 * mask the real signal. Provider health is judged from recent request outcomes (see /dependencies and the observability drawer).
 */
@Controller("health")
export class HealthController {
  constructor(@Inject(ENV) private readonly env: Env, @Inject(BudgetService) private readonly budget: BudgetService) {}

  /** Backwards-compatible summary used by tests and the dev stack. */
  @Get()
  async check(): Promise<HealthResponse> {
    try {
      await withTimeout(pool.query("select 1"), 2000);
      return { status: "ok", db: "up" };
    } catch {
      return { status: "degraded", db: "down" };
    }
  }

  @Get("live")
  live() {
    return { status: "alive", uptimeSeconds: Math.round((Date.now() - lifecycle.startedAt) / 1000) };
  }

  @Get("ready")
  async ready() {
    const checks: Record<string, string> = { configuration: "valid" };
    try {
      await withTimeout(pool.query("select 1"), 2000);
      checks.database = "healthy";
    } catch {
      checks.database = "unhealthy";
    }
    try {
      const { rows } = await withTimeout(pool.query<{ n: string }>("select count(*) n from document_chunks"), 2000);
      checks.vectorStore = Number(rows[0]!.n) > 0 ? "healthy" : "empty"; // empty is reported, not fatal: policy answers then escalate instead of being invented
    } catch {
      checks.vectorStore = "unhealthy";
    }
    checks.draining = lifecycle.draining ? "yes" : "no";
    const ready = checks.database === "healthy" && !lifecycle.draining;
    const body = { status: ready ? "healthy" : "unavailable", version: this.env.APP_VERSION, checks };
    if (!ready) throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }

  /** Restricted: configuration (names only, never values), provider state, pool and budget. */
  @Get("dependencies")
  @UseGuards(AdminGuard)
  async dependencies() {
    return {
      version: this.env.APP_VERSION,
      model: { text: this.env.OPENAI_CHAT_MODEL, embeddings: this.env.OPENAI_EMBEDDING_MODEL, live: this.env.OPENAI_REALTIME_MODEL, apiKeyConfigured: Boolean(this.env.OPENAI_API_KEY), voiceProvider: this.env.VOICE_PROVIDER ?? "openai" },
      database: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      telemetry: telemetry()?.status() ?? { disabled: true },
      budget: await this.budget.status(),
      draining: lifecycle.draining,
    };
  }
}
