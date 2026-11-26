import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { VoiceSessionStatus, VoiceTurnView } from "@support-ai/contracts";
import type pg from "pg";
import { PG_POOL } from "../../database/tokens.js";

export interface VoiceSessionRecord {
  id: string;
  sessionId: string;
  model: string;
  voice: string | null;
  status: VoiceSessionStatus;
  resumptionHandle: string | null;
  providerSessionId: string | null;
  startedAt: Date;
  endedAt: Date | null;
}
interface Row { id: string; session_id: string; model: string; voice: string | null; status: VoiceSessionStatus; resumption_handle: string | null; provider_session_id: string | null; started_at: Date; ended_at: Date | null }
const toRecord = (r: Row): VoiceSessionRecord => ({ id: r.id, sessionId: r.session_id, model: r.model, voice: r.voice, status: r.status, resumptionHandle: r.resumption_handle, providerSessionId: r.provider_session_id, startedAt: r.started_at, endedAt: r.ended_at });

/** All voice SQL lives here: the orchestrator and services hold none. */
@Injectable()
export class VoiceSessionRepository {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async create(o: { sessionId: string; model: string; voice: string; ticketHash: string; ticketTtlMs: number }): Promise<VoiceSessionRecord> {
    const { rows } = await this.pool.query<Row>(
      `insert into voice_sessions (id, session_id, model, voice, status, ticket_hash, ticket_expires_at)
       values ($1,$2,$3,$4,'connecting',$5, now() + make_interval(secs => $6)) returning *`,
      [`vs_${randomUUID()}`, o.sessionId, o.model, o.voice, o.ticketHash, o.ticketTtlMs / 1000],
    );
    return toRecord(rows[0]!);
  }

  async get(id: string): Promise<VoiceSessionRecord | null> {
    const { rows } = await this.pool.query<Row>("select * from voice_sessions where id = $1", [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async activeForSession(sessionId: string): Promise<VoiceSessionRecord | null> {
    const { rows } = await this.pool.query<Row>("select * from voice_sessions where session_id = $1 and status in ('connecting','connected','reconnecting') order by started_at desc limit 1", [sessionId]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Single use: the first caller within the TTL wins, a replay finds nothing. */
  async consumeTicket(ticketHash: string): Promise<VoiceSessionRecord | null> {
    const { rows } = await this.pool.query<Row>(
      "update voice_sessions set ticket_used_at = now() where ticket_hash = $1 and ticket_used_at is null and ticket_expires_at > now() and status in ('connecting','connected','reconnecting') returning *", [ticketHash],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async issueTicket(id: string, ticketHash: string, ttlMs: number): Promise<void> {
    await this.pool.query("update voice_sessions set ticket_hash = $2, ticket_used_at = null, ticket_expires_at = now() + make_interval(secs => $3) where id = $1", [id, ticketHash, ttlMs / 1000]);
  }

  async setStatus(id: string, status: VoiceSessionStatus, extra: { endReason?: string } = {}): Promise<void> {
    await this.pool.query(
      `update voice_sessions set status = $2, end_reason = coalesce($3, end_reason),
         connected_at = case when $2 = 'connected' and connected_at is null then now() else connected_at end,
         ended_at = case when $2 in ('ended','failed') then now() else ended_at end where id = $1`,
      [id, status, extra.endReason ?? null],
    );
  }

  async saveProviderState(id: string, p: { handle?: string; providerSessionId?: string }): Promise<void> {
    await this.pool.query("update voice_sessions set resumption_handle = coalesce($2, resumption_handle), provider_session_id = coalesce($3, provider_session_id) where id = $1", [id, p.handle ?? null, p.providerSessionId ?? null]);
  }

  /** Closes sessions left 'active' by a crashed process (nothing in this process owns them). */
  async endOrphans(liveIds: string[]): Promise<number> {
    const r = await this.pool.query("update voice_sessions set status = 'ended', end_reason = 'orphaned', ended_at = now() where status in ('connecting','connected','reconnecting') and not (id = any($1))", [liveIds]);
    return r.rowCount ?? 0;
  }

  // ---- turns -------------------------------------------------------------------------------------------------------
  async upsertTurn(t: { id: string; voiceSessionId: string; sessionId: string }): Promise<void> {
    await this.pool.query("insert into voice_turns (id, voice_session_id, session_id) values ($1,$2,$3) on conflict do nothing", [t.id, t.voiceSessionId, t.sessionId]);
  }

  async updateTurn(id: string, p: { userTranscript?: string; assistantSpoken?: string; assistantCanonical?: string | null; interrupted?: boolean; runId?: string | null; grounding?: "pending" | "verified" | "corrected" | "blocked" | "not_required"; complete?: boolean }): Promise<void> {
    await this.pool.query(
      `update voice_turns set user_transcript = coalesce($2, user_transcript), assistant_spoken = coalesce($3, assistant_spoken),
         assistant_canonical = coalesce($4, assistant_canonical), interrupted = coalesce($5, interrupted), run_id = coalesce($6, run_id),
         grounding_status = coalesce($7, grounding_status), completed_at = case when $8 then now() else completed_at end where id = $1`,
      [id, p.userTranscript ?? null, p.assistantSpoken ?? null, p.assistantCanonical ?? null, p.interrupted ?? null, p.runId ?? null, p.grounding ?? null, p.complete ?? false],
    );
  }

  /** Links the agent's own rows (user + assistant message, run) to the voice turn, and records an interruption on the assistant message. */
  async linkRun(turnId: string, runId: string): Promise<void> {
    await this.pool.query("update agent_runs set voice_turn_id = $2 where id = $1", [runId, turnId]);
    await this.pool.query("update messages set voice_turn_id = $2 where run_id = $1", [runId, turnId]);
  }

  async markInterruptedMessage(runId: string, info: Record<string, unknown>): Promise<void> {
    await this.pool.query("update messages set interruption = $2::jsonb where run_id = $1 and role = 'assistant'", [runId, JSON.stringify(info)]);
  }

  async turns(voiceSessionId: string): Promise<VoiceTurnView[]> {
    const { rows } = await this.pool.query<{ id: string; run_id: string | null; user_transcript: string; assistant_spoken: string; assistant_canonical: string | null; interrupted: boolean; created_at: Date }>(
      "select * from voice_turns where voice_session_id = $1 order by created_at", [voiceSessionId],
    );
    return rows.map((r) => ({ turnId: r.id, runId: r.run_id, userTranscript: r.user_transcript, assistantSpoken: r.assistant_spoken, assistantCanonical: r.assistant_canonical, interrupted: r.interrupted, createdAt: r.created_at.toISOString() }));
  }

  // ---- function calls ------------------------------------------------------------------------------------------------
  async recordCall(c: { voiceSessionId: string; providerCallId: string; turnId: string | null; name: string }): Promise<void> {
    await this.pool.query("insert into voice_function_calls (voice_session_id, provider_call_id, turn_id, name, status) values ($1,$2,$3,$4,'running') on conflict (voice_session_id, provider_call_id) do update set duplicate_count = voice_function_calls.duplicate_count + 1", [c.voiceSessionId, c.providerCallId, c.turnId, c.name]);
  }

  async finishCall(voiceSessionId: string, providerCallId: string, status: "completed" | "failed" | "cancelled", runId?: string): Promise<void> {
    await this.pool.query("update voice_function_calls set status = $3, run_id = coalesce($4, run_id), completed_at = now() where voice_session_id = $1 and provider_call_id = $2", [voiceSessionId, providerCallId, status, runId ?? null]);
  }

  // ---- events and usage ------------------------------------------------------------------------------------------------
  async event(voiceSessionId: string, type: string, payload: unknown): Promise<void> {
    await this.pool.query("insert into voice_events (voice_session_id, type, payload) values ($1,$2,$3::jsonb)", [voiceSessionId, type, JSON.stringify(payload ?? {})]).catch(() => undefined);
  }

  async saveUsage(voiceSessionId: string, u: { audioInputSeconds: number; audioOutputSeconds: number; inputTokens: number; outputTokens: number; audioInputTokens: number; audioOutputTokens: number; estimatedCostUsd: string | null; costNote?: string | null; pricingModel: string; pricingEffectiveDate: string | null; metrics: unknown }): Promise<void> {
    await this.pool.query(
      `insert into voice_usage (voice_session_id, audio_input_seconds, audio_output_seconds, input_tokens, output_tokens, audio_input_tokens, audio_output_tokens, estimated_cost_usd, pricing_model, pricing_effective_date, metrics)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       on conflict (voice_session_id) do update set audio_input_seconds = excluded.audio_input_seconds, audio_output_seconds = excluded.audio_output_seconds,
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, audio_input_tokens = excluded.audio_input_tokens, audio_output_tokens = excluded.audio_output_tokens,
         estimated_cost_usd = excluded.estimated_cost_usd, pricing_model = excluded.pricing_model, pricing_effective_date = excluded.pricing_effective_date, metrics = excluded.metrics, updated_at = now()`,
      [voiceSessionId, u.audioInputSeconds, u.audioOutputSeconds, u.inputTokens, u.outputTokens, u.audioInputTokens, u.audioOutputTokens, u.estimatedCostUsd, u.pricingModel, u.pricingEffectiveDate, JSON.stringify(u.metrics)],
    );
  }

  async usageMetrics(voiceSessionId: string): Promise<unknown | null> {
    const { rows } = await this.pool.query<{ metrics: unknown }>("select metrics from voice_usage where voice_session_id = $1", [voiceSessionId]);
    return rows[0]?.metrics ?? null;
  }
}
