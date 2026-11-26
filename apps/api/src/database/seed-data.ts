import type pg from "pg";
import { hashVerificationCode } from "../customers/verification-code.js";

const DAY = 86_400_000;
const daysAgo = (d: number, now: Date) => new Date(now.getTime() - d * DAY).toISOString();
const dateOnly = (offsetDays: number, now: Date) => new Date(now.getTime() + offsetDays * DAY).toISOString().slice(0, 10);

/** Demo-only credentials. These are fictional and exist so the verification flow can be exercised. */
export const DEMO_CUSTOMERS = [
  { id: "CUST-001", name: "Alex Morgan", email: "alex.morgan@example.com", code: "401923", status: "active", tier: "basic", period: "monthly", price: 1900, subStatus: "active", contract: { type: "monthly", status: "active", start: -3, end: 27 } },
  { id: "CUST-002", name: "Sarah Wilson", email: "sarah@example.com", code: "482910", status: "active", tier: "pro", period: "monthly", price: 4900, subStatus: "active", contract: { type: "monthly", status: "active", start: -35, end: 25 } },
  { id: "CUST-003", name: "James Miller", email: "james.miller@example.com", code: "730156", status: "active", tier: "pro", period: "annual", price: 4900, subStatus: "active", contract: { type: "annual", status: "active", start: -5, end: 360 } },
  { id: "CUST-004", name: "Emma Davis", email: "emma.davis@example.com", code: "915284", status: "active", tier: "enterprise", period: "annual", price: 19900, subStatus: "active", contract: { type: "annual", status: "active", start: -10, end: 355 } },
  { id: "CUST-005", name: "Daniel Brown", email: "daniel.brown@example.com", code: "268471", status: "expired", tier: "basic", period: "monthly", price: 1900, subStatus: "expired", contract: { type: "monthly", status: "expired", start: -75, end: -15 } },
  { id: "CUST-006", name: "Olivia Smith", email: "olivia.smith@example.com", code: "557392", status: "suspended", tier: "pro", period: "monthly", price: 4900, subStatus: "suspended", contract: { type: "monthly", status: "suspended", start: -20, end: 10 } },
] as const;

/** [id, customer, amountCents, daysAgo] */
const PAYMENTS: Array<[string, string, number, number]> = [
  ["PAY-001", "CUST-001", 1900, 3],
  ["PAY-002", "CUST-002", 4900, 2],
  ["PAY-003", "CUST-003", 49000, 5],
  ["PAY-004", "CUST-004", 238800, 10],
  ["PAY-005", "CUST-005", 1900, 45],
  ["PAY-006", "CUST-006", 4900, 1],
  ["PAY-007", "CUST-002", 4900, 35],
];

/** Wipes and reseeds all business data. Dates are relative to `now` so refund windows stay meaningful. */
export async function seedDatabase(db: pg.Pool, now = new Date()): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query(
      `truncate trace_spans, model_invocations, error_events, audit_logs, tool_executions, trace_events, usage_metrics, llm_calls, retrieval_results, pending_actions, messages,
                escalation_tickets, refunds, agent_runs, sessions, payments, contracts, subscriptions, customers cascade`,
    );
    // LangGraph checkpoint tables exist once the agent has started; their thread ids are session ids we just deleted.
    for (const t of ["checkpoint_writes", "checkpoint_blobs", "checkpoints"]) {
      const { rows } = await client.query("select to_regclass($1) as r", [t]);
      if (rows[0].r) await client.query(`truncate ${t}`);
    }
    await client.query("alter sequence refund_seq restart with 1");
    await client.query("alter sequence ticket_seq restart with 1");
    for (const [i, c] of DEMO_CUSTOMERS.entries()) {
      await client.query(
        `insert into customers (id, email, name, display_name, status, verification_code_hash)
         values ($1,$2,$3,$3,$4,$5)`,
        [c.id, c.email, c.name, c.status, hashVerificationCode(c.id, c.code)],
      );
      await client.query(
        `insert into subscriptions (id, customer_id, tier, billing_period, status, monthly_price_cents, started_at)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [`SUB-${String(i + 1).padStart(3, "0")}`, c.id, c.tier, c.period, c.subStatus, c.price, daysAgo(60, now)],
      );
      await client.query(
        `insert into contracts (id, customer_id, subscription_id, type, status, start_date, end_date, auto_renew)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [`CON-${String(i + 1).padStart(3, "0")}`, c.id, `SUB-${String(i + 1).padStart(3, "0")}`, c.contract.type, c.contract.status,
         dateOnly(c.contract.start, now), dateOnly(c.contract.end, now), c.contract.status === "active"],
      );
    }
    for (const [id, customerId, amount, ago] of PAYMENTS) {
      const sub = `SUB-${String(DEMO_CUSTOMERS.findIndex((c) => c.id === customerId) + 1).padStart(3, "0")}`;
      await client.query(
        "insert into payments (id, customer_id, subscription_id, amount_cents, status, paid_at) values ($1,$2,$3,$4,'succeeded',$5)",
        [id, customerId, sub, amount, daysAgo(ago, now)],
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
