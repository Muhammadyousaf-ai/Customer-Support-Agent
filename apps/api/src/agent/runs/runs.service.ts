import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type { AgentRunMetrics, AgentRunStatus } from "@support-ai/contracts";
import type pg from "pg";
import { PG_POOL } from "../../database/tokens.js";
import type { RunFlags } from "../policies/execution-budget.js";

export interface RunRecord {
  id: string;
  sessionId: string;
  status: AgentRunStatus | "executing_tool";
  mode: "chat" | "voice";
  turnId: string | null;
  clientMessageId: string | null;
  response: string | null;
  errorCode: string | null;
  metrics: AgentRunMetrics | null;
  sources: Array<{ document: string; heading: string }>;
  escalationTicketId: string | null;
  pendingActionId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface RunRow {
  id: string; session_id: string; status: RunRecord["status"]; mode: "chat" | "voice"; turn_id: string | null; client_message_id: string | null;
  response: string | null; error_code: string | null; metrics: AgentRunMetrics | null; started_at: Date; finished_at: Date | null;
  sources: Array<{ document: string; heading: string }>; escalation_ticket_id: string | null; pending_action_id: string | null;
}
const toRun = (r: RunRow): RunRecord => ({
  id: r.id, sessionId: r.session_id, status: r.status, mode: r.mode, turnId: r.turn_id, clientMessageId: r.client_message_id, response: r.response,
  errorCode: r.error_code, metrics: r.metrics, sources: r.sources ?? [], escalationTicketId: r.escalation_ticket_id, pendingActionId: r.pending_action_id, startedAt: r.started_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null,
});

@Injectable()
export class RunsService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /**
   * Starts a run. The partial unique index agent_runs_one_active_per_session makes "one active run per session"
   * a database guarantee, so two simultaneous messages cannot both execute.
   */
  async start(sessionId: string, mode: "chat" | "voice", clientMessageId: string): Promise<RunRecord> {
    try {
      const { rows } = await this.pool.query<RunRow>(
        "insert into agent_runs (id, session_id, status, mode, turn_id, client_message_id) values ($1,$2,'running',$3,$4,$5) returning *",
        [`run_${randomUUID()}`, sessionId, mode, `turn_${randomUUID()}`, clientMessageId],
      );
      return toRun(rows[0]!);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new ConflictException("A run is already executing for this session. Wait for it to finish.");
      throw err;
    }
  }

  async get(id: string): Promise<RunRecord | null> {
    const { rows } = await this.pool.query<RunRow>("select * from agent_runs where id = $1", [id]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async listForSession(sessionId: string): Promise<RunRecord[]> {
    const { rows } = await this.pool.query<RunRow>("select * from agent_runs where session_id = $1 order by started_at desc limit 50", [sessionId]);
    return rows.map(toRun);
  }

  async findPaused(sessionId: string): Promise<RunRecord | null> {
    const { rows } = await this.pool.query<RunRow>(
      "select * from agent_runs where session_id = $1 and status = 'awaiting_confirmation' order by started_at desc limit 1", [sessionId],
    );
    return rows[0] ? toRun(rows[0]) : null;
  }

  /** paused -> running, atomically. Fails if another message already resumed it. */
  async resume(id: string): Promise<void> {
    try {
      const { rowCount } = await this.pool.query("update agent_runs set status = 'running', cancel_requested = false where id = $1 and status = 'awaiting_confirmation'", [id]);
      if (!rowCount) throw new ConflictException("This run is not waiting for confirmation (it may already have been resumed).");
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new ConflictException("A run is already executing for this session.");
      throw err;
    }
  }

  async setStatus(id: string, status: RunRecord["status"]): Promise<void> {
    await this.pool.query("update agent_runs set status = $2 where id = $1", [id, status]);
  }

  async finish(id: string, result: { status: AgentRunStatus; response: string; errorCode?: string | null; metrics: AgentRunMetrics; sources?: Array<{ document: string; heading: string }>; escalationTicketId?: string | null; pendingActionId?: string | null }): Promise<void> {
    const terminal = !["awaiting_confirmation", "awaiting_input"].includes(result.status);
    await this.pool.query(
      `update agent_runs set status = $2, response = $3, error_code = $4, metrics = $5::jsonb, finished_at = case when $6 then now() else null end,
         sources = $7::jsonb, escalation_ticket_id = $8, pending_action_id = $9 where id = $1`,
      [id, result.status, result.response, result.errorCode ?? null, JSON.stringify(result.metrics), terminal, JSON.stringify(result.sources ?? []), result.escalationTicketId ?? null, result.pendingActionId ?? null],
    );
  }

  /** The database flag is the source of truth, so a cancel is never lost to timing (e.g. before the run is registered). */
  async isCancelRequested(id: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ cancel_requested: boolean }>("select cancel_requested from agent_runs where id = $1", [id]);
    return rows[0]?.cancel_requested ?? false;
  }

  async requestCancel(id: string): Promise<void> {
    await this.pool.query("update agent_runs set cancel_requested = true where id = $1", [id]);
  }

  /** After a crash a run can be left 'running' forever, blocking its session. Mark old ones failed. */
  async reapStale(maxAgeMs: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `update agent_runs set status = 'failed', error_code = 'STALE_RUN', finished_at = now()
        where status in ('running','executing_tool') and started_at < now() - make_interval(secs => $1)`,
      [maxAgeMs / 1000],
    );
    return rowCount ?? 0;
  }
}

interface ActiveRun extends RunFlags {
  controller: AbortController;
  timer?: NodeJS.Timeout;
}

/** In-process handles for runs that are executing right now: cancellation and the active-time deadline. */
@Injectable()
export class RunRegistry {
  private readonly active = new Map<string, ActiveRun>();

  register(runId: string, deadlineMs: number): ActiveRun {
    const run: ActiveRun = { controller: new AbortController(), cancelled: false, deadlineExceeded: false };
    run.timer = setTimeout(() => {
      run.deadlineExceeded = true;
      run.controller.abort();
    }, deadlineMs);
    this.active.set(runId, run);
    return run;
  }

  /** Live flags for a run. Unregistered runs get a throwaway object; callers also consult the database flag. */
  flags(runId: string): RunFlags {
    return this.active.get(runId) ?? { cancelled: false, deadlineExceeded: false };
  }

  signal(runId: string): AbortSignal | undefined {
    return this.active.get(runId)?.controller.signal;
  }

  /** Returns true if the run was executing in this process. */
  cancel(runId: string): boolean {
    const run = this.active.get(runId);
    if (!run) return false;
    run.cancelled = true;
    run.controller.abort();
    return true;
  }

  release(runId: string): void {
    const run = this.active.get(runId);
    if (run?.timer) clearTimeout(run.timer);
    this.active.delete(runId);
  }
}
