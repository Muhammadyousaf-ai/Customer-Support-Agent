import { Inject, Injectable } from "@nestjs/common";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";

export interface SseConnection {
  close(): void;
}

/** Tracks open streams per session and enforces a cap, so abandoned tabs cannot pile up connections. */
@Injectable()
export class ConnectionManager {
  private readonly bySession = new Map<string, Set<SseConnection>>();

  constructor(@Inject(ENV) private readonly env: Env) {}

  register(sessionId: string, conn: SseConnection): void {
    const set = this.bySession.get(sessionId) ?? new Set<SseConnection>();
    this.bySession.set(sessionId, set);
    set.add(conn);
    // Oldest first: a Set iterates in insertion order.
    while (set.size > this.env.SSE_MAX_CONNECTIONS_PER_SESSION) {
      const oldest = set.values().next().value as SseConnection;
      set.delete(oldest);
      oldest.close();
    }
  }

  unregister(sessionId: string, conn: SseConnection): void {
    const set = this.bySession.get(sessionId);
    set?.delete(conn);
    if (set && set.size === 0) this.bySession.delete(sessionId);
  }

  count(sessionId: string): number {
    return this.bySession.get(sessionId)?.size ?? 0;
  }
}
