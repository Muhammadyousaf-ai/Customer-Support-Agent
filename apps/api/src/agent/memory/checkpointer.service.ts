import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { Env } from "../../config/env.js";
import { ENV } from "../../config/tokens.js";

/** PostgreSQL-backed LangGraph checkpointer: graph state survives restarts, so paused runs can be resumed. */
@Injectable()
export class CheckpointerService implements OnModuleInit, OnModuleDestroy {
  readonly saver: PostgresSaver;
  private ready: Promise<void> | undefined;

  constructor(@Inject(ENV) env: Env) {
    this.saver = PostgresSaver.fromConnString(env.DATABASE_URL);
  }

  /** Creates the checkpoint tables if needed. Idempotent. */
  setup(): Promise<void> {
    this.ready ??= this.saver.setup();
    return this.ready;
  }

  async onModuleInit(): Promise<void> {
    await this.setup();
  }

  async onModuleDestroy(): Promise<void> {
    await this.saver.end();
  }
}
