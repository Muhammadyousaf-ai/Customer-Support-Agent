import { randomUUID } from "node:crypto";
import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type pg from "pg";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";
import { PG_POOL } from "../database/tokens.js";
import { lifecycle } from "../lifecycle/lifecycle-state.js";

export type BudgetKind = "run" | "voice";
interface Reservation { usd: number; expiresAt: number }

/**
 * Application-level daily spending protection. Spend comes from the Phase 7 records (model_invocations priced by the
 * registry, voice_usage); a call whose price is unknown is charged a configured amount so an unpriced model cannot run
 * unbounded. Before work starts, part of the remaining budget is RESERVED, so simultaneous requests cannot all pass the
 * check and overshoot; the reservation lapses when the run is over (its real cost is then in the records), or is
 * released explicitly. This is an approximate protective limit, not a provider-side billing cap.
 */
@Injectable()
export class BudgetService {
  private readonly held = new Map<string, Reservation>();
  private gate: Promise<unknown> = Promise.resolve();

  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(ENV) private readonly env: Env) {}

  get enabled(): boolean { return this.env.DAILY_AI_BUDGET_USD > 0; }

  private reserveAmount(kind: BudgetKind): number { return kind === "voice" ? this.env.BUDGET_VOICE_RESERVE_USD : this.env.BUDGET_RUN_RESERVE_USD; }
  private ttl(kind: BudgetKind): number { return kind === "voice" ? this.env.VOICE_MAX_SESSION_MINUTES * 60_000 + 30_000 : this.env.AGENT_DEADLINE_MS * 2; }

  private reservedUsd(): number {
    const now = Date.now();
    let total = 0;
    for (const [id, r] of this.held) {
      if (r.expiresAt <= now) this.held.delete(id);
      else total += r.usd;
    }
    return total;
  }

  async spentTodayUsd(): Promise<number> {
    const [inv, voice] = await Promise.all([
      this.pool.query<{ priced: string; unpriced: string }>("select coalesce(sum(estimated_cost_usd) filter (where cost_status = 'ok'),0) priced, count(*) filter (where cost_status <> 'ok') unpriced from model_invocations where started_at >= date_trunc('day', now())"),
      this.pool.query<{ priced: string; unpriced: string }>("select coalesce(sum(estimated_cost_usd),0) priced, count(*) filter (where estimated_cost_usd is null) unpriced from voice_usage where updated_at >= date_trunc('day', now())"),
    ]);
    return Number(inv.rows[0]!.priced) + Number(inv.rows[0]!.unpriced) * this.env.BUDGET_UNPRICED_CALL_USD + Number(voice.rows[0]!.priced) + Number(voice.rows[0]!.unpriced) * this.env.BUDGET_VOICE_RESERVE_USD;
  }

  async status() {
    const spent = await this.spentTodayUsd();
    const reserved = this.reservedUsd();
    const budget = this.env.DAILY_AI_BUDGET_USD;
    return { enabled: this.enabled, dailyBudgetUsd: budget, spentUsd: Number(spent.toFixed(6)), reservedUsd: Number(reserved.toFixed(6)), remainingUsd: this.enabled ? Math.max(0, Number((budget - spent - reserved).toFixed(6))) : null, exhausted: this.enabled && spent + reserved >= budget, note: "Approximate application limit, not a provider billing cap." };
  }

  /** 503 while draining for a restart or when the daily budget cannot cover another reserved run. Returns a reservation id. */
  async reserve(kind: BudgetKind): Promise<string> {
    if (lifecycle.draining) throw new ServiceUnavailableException({ code: "RESTARTING", message: "The service is restarting. Please try again in a few seconds." });
    if (!this.enabled) return "disabled";
    const run = async (): Promise<string> => {
      const need = this.reserveAmount(kind);
      const spent = await this.spentTodayUsd();
      if (spent + this.reservedUsd() + need > this.env.DAILY_AI_BUDGET_USD) {
        throw new ServiceUnavailableException({ code: "BUDGET_EXHAUSTED", message: "The daily AI budget for this demo has been used up, so new requests are paused. Please try again tomorrow." });
      }
      const id = randomUUID();
      this.held.set(id, { usd: need, expiresAt: Date.now() + this.ttl(kind) });
      return id;
    };
    // Serialized: the check and the reservation are one step, so concurrent callers cannot both pass the same headroom.
    const result = this.gate.then(run, run);
    this.gate = result.catch(() => undefined);
    return result;
  }

  release(id: string | undefined): void {
    if (id) this.held.delete(id);
  }
}
