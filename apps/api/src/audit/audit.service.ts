import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { PG_POOL } from "../database/tokens.js";

export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export interface AuditEntry {
  sessionId?: string;
  customerId?: string;
  /** "agent" and "system" are automated; "user" means a signed-in person (actorUserId + actorRole say who). */
  actor: "agent" | "system" | "user";
  actorUserId?: string;
  actorRole?: string;
  action: string;
  entityType: string;
  entityId: string;
  previousValue?: unknown;
  newValue?: unknown;
}

@Injectable()
export class AuditService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Pass the transaction client so the audit row commits or rolls back with the change it describes. */
  async log(entry: AuditEntry, db: Queryable = this.pool): Promise<void> {
    await db.query(
      `insert into audit_logs (session_id, customer_id, actor, actor_user_id, actor_role, action, entity_type, entity_id, previous_value, new_value)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,
      [entry.sessionId ?? null, entry.customerId ?? null, entry.actor, entry.actorUserId ?? null, entry.actorRole ?? null, entry.action, entry.entityType, entry.entityId,
       JSON.stringify(entry.previousValue ?? null), JSON.stringify(entry.newValue ?? null)],
    );
  }
}
