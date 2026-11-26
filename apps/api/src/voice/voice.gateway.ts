import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { VOICE_WS_PATH } from "@support-ai/contracts";
import { WebSocketServer, type WebSocket } from "ws";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";
import type { VoiceSocket } from "./voice-connection.js";
import { VoiceService } from "./voice.service.js";

const SUBPROTOCOL = "voice.v1";
const HEARTBEAT_MS = 20_000;
const MAX_MESSAGES_PER_SEC = 400;

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/**
 * Authenticated WebSocket endpoint for audio and voice control (`/ws/voice`). It is a thin transport: the ticket is
 * validated here, everything else is the VoiceConnection's job. The ticket travels in the WebSocket subprotocol
 * (`ticket.<value>`), not the URL, so it does not end up in access logs. It is short-lived and single-use.
 */
@Injectable()
export class VoiceGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(VoiceGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false) });
  private readonly allowedOrigins: string[];
  private heartbeat?: NodeJS.Timeout;
  private onUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  private server?: { off: (e: string, f: never) => unknown };

  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(VoiceService) private readonly voice: VoiceService,
    @Inject(ENV) env: Env,
  ) {
    this.allowedOrigins = env.WEB_ORIGIN.split(",").map((o) => o.trim());
  }

  onApplicationBootstrap(): void {
    // CLI scripts (rag:ingest, agent:eval, ...) boot the app WITHOUT an HTTP server: there is nothing to attach to.
    const server = this.host.httpAdapter?.getHttpServer() as import("node:http").Server | undefined;
    if (!server) return;
    this.onUpgrade = (req, socket, head) => void this.handleUpgrade(req, socket, head);
    server.on("upgrade", this.onUpgrade);
    this.server = server as never;
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        const w = ws as WebSocket & { alive?: boolean };
        if (w.alive === false) { w.terminate(); continue; } // stale connection: no pong since the last ping
        w.alive = false;
        w.ping();
      }
    }, HEARTBEAT_MS);
  }

  onApplicationShutdown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.onUpgrade) (this.server as unknown as { off: (e: string, f: unknown) => void } | undefined)?.off("upgrade", this.onUpgrade);
    for (const ws of this.wss.clients) ws.close(1001, "server shutdown");
    this.wss.close();
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== VOICE_WS_PATH) return; // not ours: leave it for other upgrade handlers (none today)
    try {
      const origin = req.headers.origin;
      if (origin && !this.allowedOrigins.includes(origin)) return reject(socket, 403, "Forbidden");
      const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
      const ticket = offered.find((p) => p.startsWith("ticket."))?.slice(7) ?? url.searchParams.get("ticket");
      if (!ticket) return reject(socket, 401, "Unauthorized");
      const record = await this.voice.consumeTicket(ticket);
      if (!record) return reject(socket, 401, "Unauthorized");
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, record));
    } catch (err) {
      this.logger.error(`upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
      reject(socket, 500, "Internal Server Error");
    }
  }

  private onConnection(ws: WebSocket & { alive?: boolean }, record: Parameters<VoiceService["open"]>[0]): void {
    ws.alive = true;
    ws.on("pong", () => { ws.alive = true; });
    const wrapper: VoiceSocket = {
      get isOpen() { return ws.readyState === ws.OPEN; },
      get bufferedAmount() { return ws.bufferedAmount; },
      send: (data, binary) => { if (ws.readyState === ws.OPEN) ws.send(data, { binary }); },
      close: (code, reason) => { try { ws.close(code ?? 1000, reason); } catch { /* already closing */ } },
    };
    const conn = this.voice.open(record, wrapper);
    let windowStart = Date.now();
    let count = 0;
    ws.on("message", (data, isBinary) => {
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; count = 0; }
      if (++count > MAX_MESSAGES_PER_SEC) return ws.close(1008, "rate limit");
      if (isBinary) conn.onClientAudio(new Uint8Array(data as Buffer));
      else conn.onClientText(data.toString());
    });
    ws.on("close", () => conn.detach(wrapper));
    ws.on("error", (err) => this.logger.warn(`voice socket error: ${err.message}`));
  }
}
