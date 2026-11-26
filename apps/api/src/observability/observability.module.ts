import { Inject, Module, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import type pg from "pg";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";
import { PG_POOL } from "../database/tokens.js";
import { SessionAuthService } from "../sessions/session-auth.service.js";
import { SessionsService } from "../sessions/sessions.service.js";
import { moduleLogger } from "./logging/logger.js";
import { ObservabilityController } from "./observability.controller.js";
import { ObservabilityService } from "./observability.service.js";
import { TelemetryWriter, setTelemetryWriter } from "./persistence/telemetry-writer.js";
import { pricingRegistry } from "./pricing/pricing-registry.js";
import { ensureTracing } from "./tracing/tracing.js";

const log = moduleLogger("observability");

/**
 * Wires the process-wide tracer to the database. Instrumented code calls withSpan() directly (no injection), so it works
 * without this module (as a no-op); loading the module turns recording on.
 */
@Module({ controllers: [ObservabilityController], providers: [ObservabilityService, SessionsService, SessionAuthService] })
export class ObservabilityModule implements OnModuleInit, OnApplicationShutdown {
  private writer: TelemetryWriter | null = null;
  private purgeTimer: NodeJS.Timeout | null = null;

  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(ENV) private readonly env: Env) {}

  async onModuleInit(): Promise<void> {
    if (this.env.TELEMETRY_ENABLED !== "true") return;
    this.writer = new TelemetryWriter(this.pool, { maxQueue: this.env.TELEMETRY_QUEUE_MAX, flushMs: this.env.TELEMETRY_FLUSH_MS });
    this.writer.start();
    setTelemetryWriter(this.writer);
    ensureTracing();
    await this.syncPricing();
    const purge = async () => {
      const n = await this.writer?.purge(this.env.TELEMETRY_RETENTION_DAYS).catch(() => 0);
      if (n) log.info({ event: "telemetry.purged", rows: n, retentionDays: this.env.TELEMETRY_RETENTION_DAYS }, "purged expired diagnostic traces");
    };
    void purge();
    this.purgeTimer = setInterval(() => void purge(), 6 * 3600_000);
    this.purgeTimer.unref?.();
  }

  /** Mirrors the code-defined price list into model_pricing so stored estimates can always be traced back to their rates. */
  private async syncPricing(): Promise<void> {
    try {
      for (const p of pricingRegistry.all()) {
        const { model, effectiveFrom, effectiveUntil, sourceUrl, verifiedOn, currency, provider: _p, ...rates } = p;
        await this.pool.query(
          `insert into model_pricing (model, effective_from, effective_until, currency, rates, source_url, verified_on) values ($1,$2,$3,$4,$5::jsonb,$6,$7)
           on conflict (model, effective_from) do update set effective_until = excluded.effective_until, rates = excluded.rates, source_url = excluded.source_url, verified_on = excluded.verified_on`,
          [model, effectiveFrom, effectiveUntil ?? null, currency, JSON.stringify(rates), sourceUrl, verifiedOn],
        );
      }
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "pricing sync failed; estimates still use the in-code registry");
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    await this.writer?.stop();
    setTelemetryWriter(null);
  }
}
