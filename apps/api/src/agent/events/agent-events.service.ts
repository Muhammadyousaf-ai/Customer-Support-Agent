import { Inject, Injectable, Logger } from "@nestjs/common";
import type { AgentEvent, AgentEventPayloads, AgentEventType } from "@support-ai/contracts";
import type pg from "pg";
import { Subject, filter, type Subscription } from "rxjs";
import { PG_POOL } from "../../database/tokens.js";
import { ToolEventsService } from "../../tools/events/tool-events.service.js";
import { redact } from "../../tools/registry/tool-executor.service.js";

/**
 * The application event stream. The frontend (Phase 5 SSE, Phase 6 voice) only ever sees these events, never
 * LangGraph state. Every event has run id, session id, a strictly increasing sequence number and a timestamp,
 * and is persisted (sanitized) to trace_events so a run can be replayed later.
 */
@Injectable()
export class AgentEventsService {
  private readonly logger = new Logger(AgentEventsService.name);
  private readonly subject = new Subject<AgentEvent>();
  private readonly seq = new Map<string, number>();
  /** Per-session sequence. Safe because a session has at most one active run (database guarantee) in one process. */
  private readonly sessionSeq = new Map<string, number>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly runSession = new Map<string, string>();
  private readonly bridges = new Map<string, Subscription>();
  readonly events$ = this.subject.asObservable();

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(ToolEventsService) private readonly toolEvents: ToolEventsService,
  ) {}

  /** Start collecting for a run: continue its sequence after a pause, and forward Phase 3 tool events. */
  async begin(runId: string, sessionId: string): Promise<void> {
    const { rows } = await this.pool.query<{ max: number | null }>("select max(seq) as max from trace_events where run_id = $1", [runId]);
    this.seq.set(runId, rows[0]?.max ?? 0);
    this.runSession.set(runId, sessionId);
    const s = await this.pool.query<{ max: string | null }>("select max(session_seq) as max from trace_events where session_id = $1", [sessionId]);
    this.sessionSeq.set(sessionId, Math.max(this.sessionSeq.get(sessionId) ?? 0, Number(s.rows[0]?.max ?? 0)));
    this.bridges.get(runId)?.unsubscribe();
    this.bridges.set(
      runId,
      this.toolEvents.ofRun(runId).subscribe((e) => this.emit(e.type, sessionId, runId, e.data as AgentEventPayloads[typeof e.type])),
    );
  }

  emit<K extends AgentEventType>(type: K, sessionId: string, runId: string, data: K extends keyof AgentEventPayloads ? AgentEventPayloads[K] : unknown): AgentEvent {
    const seq = (this.seq.get(runId) ?? 0) + 1;
    this.seq.set(runId, seq);
    const sessionSeq = (this.sessionSeq.get(sessionId) ?? 0) + 1;
    this.sessionSeq.set(sessionId, sessionSeq);
    const event: AgentEvent = { type, sessionId, runId, seq, sessionSeq, ts: new Date().toISOString(), data };
    this.subject.next(event);
    this.logEvent(type, runId, data);
    const previous = this.queues.get(runId) ?? Promise.resolve();
    this.queues.set(
      runId,
      previous.then(() =>
        this.pool
          .query("insert into trace_events (run_id, session_id, seq, session_seq, type, data) values ($1,$2,$3,$4,$5,$6::jsonb) on conflict do nothing", [runId, sessionId, seq, sessionSeq, type, JSON.stringify(redact(data))])
          .then(() => undefined, (err: unknown) => this.logger.error(`failed to persist ${type}: ${err instanceof Error ? err.message : String(err)}`)),
      ),
    );
    return event;
  }

  /** One console line per event, redacted the same way as the persisted trace. Failures are warnings. */
  private logEvent(type: string, runId: string, data: unknown): void {
    const detail = data && typeof data === "object" && Object.keys(data).length ? ` ${JSON.stringify(redact(data)).slice(0, 300)}` : "";
    const line = `run …${runId.slice(-8)} · ${type}${detail}`;
    if (type.endsWith(".failed")) this.logger.warn(line);
    else this.logger.log(line);
  }

  /** Waits for persistence and stops forwarding. Call when a run finishes or pauses. */
  async end(runId: string): Promise<void> {
    await (this.queues.get(runId) ?? Promise.resolve());
    this.bridges.get(runId)?.unsubscribe();
    this.bridges.delete(runId);
    this.queues.delete(runId);
    this.seq.delete(runId);
    this.runSession.delete(runId);
  }

  /** Waits until every event emitted so far for this session is persisted (used before an SSE replay query). */
  async flushSession(sessionId: string): Promise<void> {
    const pending = [...this.runSession].filter(([, sid]) => sid === sessionId).map(([runId]) => this.queues.get(runId) ?? Promise.resolve());
    await Promise.all(pending);
  }

  ofSession(sessionId: string) {
    return this.events$.pipe(filter((e) => e.sessionId === sessionId));
  }
}
