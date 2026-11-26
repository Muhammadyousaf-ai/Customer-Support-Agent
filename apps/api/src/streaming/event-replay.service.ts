import { Inject, Injectable } from "@nestjs/common";
import { toEnvelope, type AgentEvent, type AgentEventType, type SseEnvelope } from "@support-ai/contracts";
import type pg from "pg";
import { PG_POOL } from "../database/tokens.js";
import { AgentEventsService } from "../agent/events/agent-events.service.js";

interface Row { run_id: string; session_id: string; session_seq: string; seq: number; type: AgentEventType; data: unknown; created_at: Date }
const toEnv = (r: Row): SseEnvelope => toEnvelope({ type: r.type, sessionId: r.session_id, runId: r.run_id, seq: r.seq, sessionSeq: Number(r.session_seq), ts: r.created_at.toISOString(), data: r.data } as AgentEvent);

/** Reads persisted events so a reconnecting client can catch up on what it missed. */
@Injectable()
export class EventReplayService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(AgentEventsService) private readonly events: AgentEventsService,
  ) {}

  /**
   * Events after `lastSequence`. With no cursor (a fresh page load) it returns the most recent run's events, so the UI
   * can rebuild the live activity of an in-flight run without replaying a whole conversation.
   */
  async after(sessionId: string, lastSequence: number | undefined): Promise<SseEnvelope[]> {
    await this.events.flushSession(sessionId); // everything emitted before the live subscription is on disk
    if (lastSequence !== undefined) {
      const { rows } = await this.pool.query<Row>("select run_id, session_id, session_seq, seq, type, data, created_at from trace_events where session_id = $1 and session_seq > $2 and session_seq is not null order by session_seq", [sessionId, lastSequence]);
      return rows.map(toEnv);
    }
    const { rows } = await this.pool.query<Row>(
      `select run_id, session_id, session_seq, seq, type, data, created_at from trace_events
        where session_id = $1 and session_seq is not null
          and run_id = (select run_id from trace_events where session_id = $1 and session_seq is not null order by session_seq desc limit 1)
        order by session_seq`,
      [sessionId],
    );
    return rows.map(toEnv);
  }
}
