import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { containsPattern } from "../common/like.js";
import { PG_POOL } from "../database/tokens.js";

export const MAX_VERIFY_ATTEMPTS = 5;
const DEFAULT_TTL_MINUTES = 60;

export interface SessionRecord {
  id: string;
  customerId: string | null;
  identityVerified: boolean;
  verifyAttempts: number;
  expiresAt: Date;
}

interface SessionRow {
  id: string;
  customer_id: string | null;
  identity_verified: boolean;
  verify_attempts: number;
  expires_at: Date;
}
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const toRecord = (r: SessionRow): SessionRecord => ({
  id: r.id, customerId: r.customer_id, identityVerified: r.identity_verified, verifyAttempts: r.verify_attempts, expiresAt: r.expires_at,
});

/** Backend-owned session state. Verification lives here, so knowing an email never authorizes anything. */
@Injectable()
export class SessionsService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async create(ttlMinutes = DEFAULT_TTL_MINUTES): Promise<SessionRecord> {
    const { rows } = await this.pool.query<SessionRow>(
      `insert into sessions (id, expires_at) values ($1, now() + make_interval(mins => $2)) returning *`,
      [`ses_${randomUUID()}`, ttlMinutes],
    );
    return toRecord(rows[0]!);
  }

  /** Creates a session and returns a one-time bearer token (only its hash is stored). */
  async createWithToken(ttlMinutes = DEFAULT_TTL_MINUTES, userId?: string): Promise<{ session: SessionRecord; token: string }> {
    const token = randomBytes(24).toString("base64url");
    const { rows } = await this.pool.query<SessionRow>(
      `insert into sessions (id, token_hash, expires_at, user_id) values ($1, $2, now() + make_interval(mins => $3), $4) returning *`,
      [`ses_${randomUUID()}`, hashToken(token), ttlMinutes, userId ?? null],
    );
    return { session: toRecord(rows[0]!), token };
  }

  /** The account that owns this conversation (null for an anonymous demo session). */
  async ownerOf(sessionId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ user_id: string | null; expires_at: Date }>("select user_id, expires_at from sessions where id = $1 and deleted_at is null", [sessionId]);
    return rows[0] && rows[0].expires_at.getTime() > Date.now() ? rows[0].user_id : null;
  }

  /** A signed-in owner can always get back into their conversation on any device: this mints a fresh conversation token. */
  async rotateToken(sessionId: string, userId: string, ttlMinutes = 24 * 60): Promise<string | null> {
    const token = randomBytes(24).toString("base64url");
    const { rowCount } = await this.pool.query("update sessions set token_hash = $3, expires_at = greatest(expires_at, now() + make_interval(mins => $4)) where id = $1 and user_id = $2 and deleted_at is null", [sessionId, userId, hashToken(token), ttlMinutes]);
    return rowCount ? token : null;
  }

  /** The user's live conversations; `q` matches the title or any message in it. `userId` comes from the auth session only. */
  async listForUser(userId: string, q?: string) {
    const { rows } = await this.pool.query(
      `select s.id, s.title, s.created_at, s.handover_mode from sessions s where s.user_id = $1 and s.deleted_at is null
         and ($2::text is null or s.title ilike $2 or exists (select 1 from messages m where m.session_id = s.id and m.content ilike $2))
       order by s.created_at desc limit 100`,
      [userId, q ? containsPattern(q) : null],
    );
    return rows.map((r) => ({ id: r.id as string, title: (r.title as string | null) ?? null, createdAt: (r.created_at as Date).toISOString(), handoverMode: r.handover_mode as string }));
  }

  /** Soft-deletes a conversation the user owns. Its tokens stop working; history is kept for support and audit. */
  async deleteForUser(sessionId: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("update sessions set deleted_at = now(), token_hash = null where id = $1 and user_id = $2 and deleted_at is null", [sessionId, userId]);
    return (rowCount ?? 0) > 0;
  }

  async handoverMode(sessionId: string): Promise<"AI_ACTIVE" | "WAITING_FOR_STAFF" | "HUMAN_ACTIVE"> {
    const { rows } = await this.pool.query<{ handover_mode: "AI_ACTIVE" | "WAITING_FOR_STAFF" | "HUMAN_ACTIVE" }>("select handover_mode from sessions where id = $1", [sessionId]);
    return rows[0]?.handover_mode ?? "AI_ACTIVE";
  }

  /** Session ownership check: the bearer token must match and the session must not be expired. */
  async authenticate(sessionId: string, token: string | undefined): Promise<SessionRecord | null> {
    if (!token) return null;
    const { rows } = await this.pool.query<SessionRow & { token_hash: string | null }>("select * from sessions where id = $1 and deleted_at is null", [sessionId]);
    const row = rows[0];
    if (!row?.token_hash || row.expires_at.getTime() <= Date.now()) return null;
    const a = Buffer.from(hashToken(token));
    const b = Buffer.from(row.token_hash);
    return a.length === b.length && timingSafeEqual(a, b) ? toRecord(row) : null;
  }

  async get(id: string): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query<SessionRow>("select * from sessions where id = $1", [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Atomic increment so parallel guesses cannot exceed the limit. Returns the new attempt count. */
  async recordVerifyAttempt(id: string): Promise<number> {
    const { rows } = await this.pool.query<{ verify_attempts: number }>(
      "update sessions set verify_attempts = verify_attempts + 1 where id = $1 returning verify_attempts",
      [id],
    );
    return rows[0]?.verify_attempts ?? MAX_VERIFY_ATTEMPTS + 1;
  }

  async markVerified(id: string, customerId: string): Promise<void> {
    await this.pool.query(
      "update sessions set customer_id = $2, identity_verified = true, verified_at = now(), verify_attempts = 0 where id = $1",
      [id, customerId],
    );
  }

  /** LangGraph thread id for this session. Chat and voice share it. */
  async threadId(sessionId: string): Promise<string> {
    const { rows } = await this.pool.query<{ thread_gen: number }>("select thread_gen from sessions where id = $1", [sessionId]);
    return `${sessionId}:${rows[0]?.thread_gen ?? 0}`;
  }

  /** Abandons a graph thread that can no longer be resumed (for example after a crash mid-pause). */
  async abandonThread(sessionId: string): Promise<void> {
    await this.pool.query("update sessions set thread_gen = thread_gen + 1 where id = $1", [sessionId]);
  }

  async startRun(sessionId: string, mode: "chat" | "voice" = "chat"): Promise<string> {
    const id = `run_${randomUUID()}`;
    await this.pool.query("insert into agent_runs (id, session_id, status, mode) values ($1,$2,'running',$3)", [id, sessionId, mode]);
    return id;
  }

  async runBelongsToSession(runId: string, sessionId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("select 1 from agent_runs where id = $1 and session_id = $2", [runId, sessionId]);
    return (rowCount ?? 0) > 0;
  }
}
