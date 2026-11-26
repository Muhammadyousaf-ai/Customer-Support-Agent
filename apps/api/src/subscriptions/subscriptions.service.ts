import { Inject, Injectable } from "@nestjs/common";
import type { BillingPeriod, Tier } from "@support-ai/contracts";
import type pg from "pg";
import { PG_POOL } from "../database/tokens.js";

export interface SubscriptionRecord {
  id: string;
  tier: Tier;
  billingPeriod: BillingPeriod;
  status: "active" | "expired" | "suspended" | "cancelled";
  monthlyPriceCents: number;
  currency: string;
}

@Injectable()
export class SubscriptionsService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async getForCustomer(customerId: string): Promise<SubscriptionRecord | null> {
    const { rows } = await this.pool.query(
      "select id, tier, billing_period, status, monthly_price_cents, currency from subscriptions where customer_id = $1",
      [customerId],
    );
    const r = rows[0];
    return r ? { id: r.id, tier: r.tier, billingPeriod: r.billing_period, status: r.status, monthlyPriceCents: r.monthly_price_cents, currency: r.currency } : null;
  }
}
