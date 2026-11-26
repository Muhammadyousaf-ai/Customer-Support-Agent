import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { PG_POOL } from "../../database/tokens.js";

export interface StoredMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  mode: "chat" | "voice";
  runId: string | null;
  clientMessageId: string | null;
  createdAt: string;
  /** Who wrote it: the AI, the customer, or a human support agent (after a handover). */
  author: "ai" | "customer" | "staff";
}

interface MessageRow {
  id: string; role: "user" | "assistant"; content: string; mode: "chat" | "voice"; run_id: string | null; client_message_id: string | null; created_at: Date; author?: "ai" | "customer" | "staff";
}
const toMessage = (r: MessageRow): StoredMessage => ({
  id: Number(r.id), role: r.role, content: r.content, mode: r.mode, runId: r.run_id, clientMessageId: r.client_message_id, createdAt: r.created_at.toISOString(), author: r.author ?? (r.role === "user" ? "customer" : "ai"),
});

/**
 * Conversation memory. PostgreSQL is the source of truth for what was said, shared by chat and voice, so a customer
 * can start in one mode and continue in the other under the same session id.
 */
@Injectable()
export class ConversationMemoryService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Idempotent on (session, clientMessageId): a resent message returns the original row. */
  async append(m: { sessionId: string; role: "user" | "assistant"; content: string; mode: "chat" | "voice"; runId?: string; clientMessageId?: string }): Promise<{ message: StoredMessage; duplicate: boolean }> {
    const { rows } = await this.pool.query<MessageRow>(
      `insert into messages (session_id, role, mode, content, run_id, client_message_id) values ($1,$2,$3,$4,$5,$6)
       on conflict (session_id, client_message_id) where client_message_id is not null do nothing returning *`,
      [m.sessionId, m.role, m.mode, m.content, m.runId ?? null, m.clientMessageId ?? null],
    );
    if (rows[0]) return { message: toMessage(rows[0]), duplicate: false };
    const existing = await this.findByClientId(m.sessionId, m.clientMessageId!);
    return { message: existing!, duplicate: true };
  }

  async findByClientId(sessionId: string, clientMessageId: string): Promise<StoredMessage | null> {
    const { rows } = await this.pool.query<MessageRow>("select * from messages where session_id = $1 and client_message_id = $2", [sessionId, clientMessageId]);
    return rows[0] ? toMessage(rows[0]) : null;
  }

  /** The last `limit` messages, oldest first. This window (plus the summary) is all the model sees of the past. */
  async recent(sessionId: string, limit: number): Promise<StoredMessage[]> {
    const { rows } = await this.pool.query<MessageRow>(
      "select * from (select * from messages where session_id = $1 order by id desc limit $2) t order by id asc", [sessionId, limit],
    );
    return rows.map(toMessage);
  }

  async list(sessionId: string): Promise<StoredMessage[]> {
    const { rows } = await this.pool.query<MessageRow>("select * from messages where session_id = $1 order by id asc", [sessionId]);
    return rows.map(toMessage);
  }

  async getSummary(sessionId: string): Promise<{ summary: string | null; throughId: number }> {
    const { rows } = await this.pool.query<{ conversation_summary: string | null; summarized_through: string }>(
      "select conversation_summary, summarized_through from sessions where id = $1", [sessionId],
    );
    return { summary: rows[0]?.conversation_summary ?? null, throughId: Number(rows[0]?.summarized_through ?? 0) };
  }

  async setSummary(sessionId: string, summary: string, throughId: number): Promise<void> {
    await this.pool.query("update sessions set conversation_summary = $2, summarized_through = $3 where id = $1", [sessionId, summary, throughId]);
  }

  /** Messages older than the window that the summary does not cover yet. */
  async unsummarizedOlderThanWindow(sessionId: string, window: number, throughId: number): Promise<StoredMessage[]> {
    const { rows } = await this.pool.query<MessageRow>(
      `select * from messages where session_id = $1 and id > $2
         and id < coalesce((select min(id) from (select id from messages where session_id = $1 order by id desc limit $3) w), 0)
       order by id asc`,
      [sessionId, throughId, window],
    );
    return rows.map(toMessage);
  }
}
