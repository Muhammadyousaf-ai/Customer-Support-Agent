import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { PG_POOL } from "../database/tokens.js";
import type { Queryable } from "../audit/audit.service.js";

export interface PaymentRecord {
  id: string;
  customerId: string;
  amountCents: number;
  currency: string;
  status: "succeeded" | "failed" | "pending";
  paidAt: Date;
  refundedCents: number;
}

interface PaymentRow {
  id: string; customer_id: string; amount_cents: number; currency: string; status: PaymentRecord["status"]; paid_at: Date; refunded_cents: number;
}
export const toPayment = (r: PaymentRow): PaymentRecord => ({
  id: r.id, customerId: r.customer_id, amountCents: r.amount_cents, currency: r.currency, status: r.status, paidAt: r.paid_at, refundedCents: r.refunded_cents,
});

@Injectable()
export class PaymentsService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async history(customerId: string, limit = 10): Promise<PaymentRecord[]> {
    const { rows } = await this.pool.query<PaymentRow>("select * from payments where customer_id = $1 order by paid_at desc limit $2", [customerId, limit]);
    return rows.map(toPayment);
  }

  async getById(id: string, db: Queryable = this.pool, lock = false): Promise<PaymentRecord | null> {
    const { rows } = await db.query<PaymentRow>(`select * from payments where id = $1${lock ? " for update" : ""}`, [id]);
    return rows[0] ? toPayment(rows[0]) : null;
  }
}
