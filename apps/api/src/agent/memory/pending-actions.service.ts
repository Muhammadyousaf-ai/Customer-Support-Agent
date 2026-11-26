import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { PG_POOL } from "../../database/tokens.js";
import { canonicalJson } from "../../tools/middleware/idempotency.service.js";
import type { PendingActionState } from "../state/agent-state.js";

export type PendingActionStatus = "pending" | "confirmed" | "declined" | "expired" | "superseded" | "executed" | "failed";

export interface PendingActionRecord {
  id: string;
  sessionId: string;
  runId: string;
  customerId: string;
  type: "refund" | "account_update";
  tool: string;
  arguments: Record<string, unknown>;
  argumentsHash: string;
  summary: string;
  status: PendingActionStatus;
  expiresAt: Date;
  amountCents: number | null;
  currency: string | null;
  display: Record<string, string>;
}

interface Row {
  id: string; session_id: string; run_id: string; customer_id: string; type: PendingActionRecord["type"]; tool: string;
  arguments: Record<string, unknown>; arguments_hash: string; summary: string; status: PendingActionStatus; expires_at: Date; amount_cents: number | null; currency: string | null; display: Record<string, string>;
}
const toRecord = (r: Row): PendingActionRecord => ({
  id: r.id, sessionId: r.session_id, runId: r.run_id, customerId: r.customer_id, type: r.type, tool: r.tool, arguments: r.arguments,
  argumentsHash: r.arguments_hash, summary: r.summary, status: r.status, expiresAt: r.expires_at, amountCents: r.amount_cents, currency: r.currency, display: r.display ?? {},
});

export const hashArguments = (tool: string, args: unknown) => createHash("sha256").update(`${tool}|${canonicalJson(args)}`).digest("hex");
/** Deterministic id: the same proposed call in the same run always maps to the same action (idempotent on replay). */
export const actionIdFor = (runId: string, toolCallId: string) => `ACT-${createHash("sha256").update(`${runId}|${toolCallId}`).digest("hex").slice(0, 10)}`;

/**
 * A confirmation is bound to one specific action: this customer, this tool, these exact arguments, until it
 * expires. A generic "yes" can only ever confirm the one pending action; it cannot authorize anything else.
 */
@Injectable()
export class PendingActionsService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Returns created=false when the action already existed (the graph node is re-run after a resume). */
  async createIfAbsent(a: { sessionId: string; runId: string; customerId: string; state: PendingActionState }): Promise<{ created: boolean }> {
    const { rowCount } = await this.pool.query(
      `insert into pending_actions (id, session_id, run_id, customer_id, type, tool, arguments, arguments_hash, amount_cents, currency, summary, expires_at, display)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb) on conflict (id) do nothing`,
      [a.state.actionId, a.sessionId, a.runId, a.customerId, a.state.type, a.state.toolName, JSON.stringify(a.state.arguments), a.state.argumentsHash,
       a.state.amountCents ?? null, a.state.currency ?? null, a.state.summary, a.state.expiresAt, JSON.stringify(a.state.display)],
    );
    return { created: (rowCount ?? 0) > 0 };
  }

  async get(id: string): Promise<PendingActionRecord | null> {
    const { rows } = await this.pool.query<Row>("select * from pending_actions where id = $1", [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Only a still-pending action can move; returns false if it already changed (e.g. a double confirmation). */
  async transition(id: string, from: PendingActionStatus, to: PendingActionStatus): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "update pending_actions set status = $3, resolved_at = case when $3 in ('pending','confirmed') then null else now() end where id = $1 and status = $2",
      [id, from, to],
    );
    return (rowCount ?? 0) > 0;
  }

  async listForSession(sessionId: string): Promise<PendingActionRecord[]> {
    const { rows } = await this.pool.query<Row>("select * from pending_actions where session_id = $1 order by created_at", [sessionId]);
    return rows.map(toRecord);
  }
}
