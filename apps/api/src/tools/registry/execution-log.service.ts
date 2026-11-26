import { Inject, Injectable, Logger } from "@nestjs/common";
import type pg from "pg";
import { PG_POOL } from "../../database/tokens.js";
import type { ExecutionLog, ExecutionLogEntry } from "./tool-definition.interface.js";

/** Persists every tool call (arguments already redacted) to tool_executions. */
@Injectable()
export class ExecutionLogService implements ExecutionLog {
  private readonly logger = new Logger(ExecutionLogService.name);

  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async record(e: ExecutionLogEntry): Promise<void> {
    try {
      await this.pool.query(
        `insert into tool_executions (id, run_id, session_id, tool_call_id, tool, tool_type, args, result, status, error_code, attempts, duration_ms, idempotency_key)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13)`,
        [e.executionId, e.runId, e.sessionId, e.toolCallId, e.tool, e.toolType ?? null, JSON.stringify(e.args ?? null), JSON.stringify(e.result ?? null),
         e.status, e.errorCode ?? null, e.attempts, e.durationMs, e.idempotencyKey ?? null],
      );
    } catch (err) {
      // Logging must never change the outcome of the business action that already happened.
      this.logger.error(`failed to persist tool execution ${e.executionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
