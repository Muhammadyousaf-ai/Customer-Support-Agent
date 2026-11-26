import { Inject, Injectable } from "@nestjs/common";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";

/** Periodic SSE comment lines keep idle connections alive through proxies and let clients detect dead streams. */
@Injectable()
export class HeartbeatService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  start(write: (chunk: string) => void): () => void {
    const timer = setInterval(() => write(`: ping ${Date.now()}\n\n`), this.env.SSE_HEARTBEAT_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
