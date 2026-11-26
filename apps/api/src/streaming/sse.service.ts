import { Inject, Injectable } from "@nestjs/common";
import type { SseEnvelope } from "@support-ai/contracts";
import type { Request, Response } from "express";
import { ConnectionManager } from "./connection-manager.service.js";
import { EventPublisherService } from "./event-publisher.service.js";
import { EventReplayService } from "./event-replay.service.js";
import { HeartbeatService } from "./heartbeat.service.js";

/** Wire format: `id` carries the session sequence so the browser's Last-Event-ID is exactly the resume cursor. */
export const frame = (e: SseEnvelope) => `id: ${e.sequence}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

export function parseLastEventId(req: Pick<Request, "headers" | "query">): number | undefined {
  const raw = (req.headers["last-event-id"] as string | undefined) ?? (typeof req.query.lastEventId === "string" ? req.query.lastEventId : undefined);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

@Injectable()
export class SseService {
  constructor(
    @Inject(EventPublisherService) private readonly publisher: EventPublisherService,
    @Inject(EventReplayService) private readonly replay: EventReplayService,
    @Inject(ConnectionManager) private readonly connections: ConnectionManager,
    @Inject(HeartbeatService) private readonly heartbeat: HeartbeatService,
  ) {}

  /**
   * Opens the stream. Order matters: subscribe to live events FIRST (buffering), THEN read the replay from the
   * database, then flush the buffer. Anything emitted during the replay query is in the buffer; anything emitted
   * before the subscription is on disk. Sequence numbers de-duplicate the overlap, so nothing is lost or repeated.
   */
  async open(sessionId: string, req: Request, res: Response): Promise<void> {
    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // nginx/Railway-style proxies: do not buffer
    });
    res.flushHeaders();
    res.write("retry: 3000\n\n");

    let lastSent = parseLastEventId(req) ?? -1;
    let replaying = true;
    const buffer: SseEnvelope[] = [];
    const send = (e: SseEnvelope) => {
      if (e.sequence <= lastSent || res.writableEnded) return;
      lastSent = e.sequence;
      res.write(frame(e));
    };

    const sub = this.publisher.live(sessionId).subscribe((e) => (replaying ? buffer.push(e) : send(e)));
    const stopHeartbeat = this.heartbeat.start((c) => !res.writableEnded && res.write(c));
    const conn = { close: () => res.end() };
    this.connections.register(sessionId, conn);
    const cleanup = () => {
      sub.unsubscribe();
      stopHeartbeat();
      this.connections.unregister(sessionId, conn);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);

    try {
      for (const e of await this.replay.after(sessionId, parseLastEventId(req))) send(e);
    } finally {
      replaying = false;
    }
    for (const e of buffer.sort((a, b) => a.sequence - b.sequence)) send(e);
  }
}
