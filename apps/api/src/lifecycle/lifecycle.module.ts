import { type BeforeApplicationShutdown, Inject, Injectable, Logger, Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module.js";
import { AgentService } from "../agent/agent.service.js";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";
import { lifecycle } from "./lifecycle-state.js";

/**
 * SIGTERM handling for a long-lived process (SSE, WebSocket, agent runs):
 *  1. stop being ready and refuse new agent runs / voice sessions (503),
 *  2. give in-flight agent runs a bounded time to finish (their state is checkpointed in PostgreSQL either way),
 *  3. then Nest closes the rest: voice sessions are ended (the provider closes; an answer or committed refund survives),
 *     telemetry is flushed, SSE streams are closed.
 * A run still executing when the grace period ends is reaped as failed on the next boot, never left holding a session lock.
 */
@Injectable()
export class LifecycleService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(LifecycleService.name);
  constructor(@Inject(AgentService) private readonly agent: AgentService, @Inject(ENV) private readonly env: Env) {}

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    lifecycle.draining = true;
    this.logger.warn(`shutting down (${signal ?? "close"}): draining for up to ${this.env.SHUTDOWN_GRACE_MS} ms`);
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      this.agent.idle().then(() => "drained" as const),
      new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), this.env.SHUTDOWN_GRACE_MS); }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === "timeout") this.logger.error("grace period elapsed with agent runs still executing; they will be reaped on the next start");
  }
}

@Module({ imports: [AgentModule], providers: [LifecycleService] })
export class LifecycleModule {}
