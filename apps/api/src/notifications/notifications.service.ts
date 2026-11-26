import { Inject, Injectable } from "@nestjs/common";
import { Subject, filter, type Observable } from "rxjs";
import type pg from "pg";
import { PG_POOL } from "../database/tokens.js";

export interface UserEvent { userId: string; type: "notification" | "ticket.updated" | "ticket.message"; data: Record<string, unknown> }
type Db = Pick<pg.Pool, "query">;

/** In-app notifications (persisted) plus a per-user live event feed that the SSE endpoint streams. */
@Injectable()
export class NotificationsService {
  private readonly hub = new Subject<UserEvent>();
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  ofUser(userId: string): Observable<UserEvent> {
    return this.hub.pipe(filter((e) => e.userId === userId));
  }

  emit(e: UserEvent): void {
    this.hub.next(e);
  }

  async notify(userId: string, kind: string, title: string, body?: string, ticketId?: string, db: Db = this.pool): Promise<void> {
    const { rows } = await db.query("insert into notifications (user_id, kind, title, body, ticket_id) values ($1,$2,$3,$4,$5) returning id, created_at", [userId, kind, title, body ?? null, ticketId ?? null]);
    // Emitted after the insert; if the surrounding transaction later rolls back the client just sees an extra live hint it cannot open.
    this.emit({ userId, type: "notification", data: { id: Number(rows[0].id), kind, title, body: body ?? null, ticketId: ticketId ?? null, createdAt: rows[0].created_at.toISOString() } });
  }

  async list(userId: string, limit = 50) {
    const { rows } = await this.pool.query("select id, kind, title, body, ticket_id, created_at, read_at from notifications where user_id = $1 order by id desc limit $2", [userId, Math.min(limit, 200)]);
    const unread = Number((await this.pool.query("select count(*) n from notifications where user_id = $1 and read_at is null", [userId])).rows[0].n);
    return { unread, items: rows.map((r) => ({ id: Number(r.id), kind: r.kind as string, title: r.title as string, body: r.body as string | null, ticketId: r.ticket_id as string | null, createdAt: (r.created_at as Date).toISOString(), read: Boolean(r.read_at) })) };
  }

  async markRead(userId: string, id?: number): Promise<void> {
    await this.pool.query("update notifications set read_at = now() where user_id = $1 and read_at is null and ($2::bigint is null or id = $2)", [userId, id ?? null]);
  }
}
