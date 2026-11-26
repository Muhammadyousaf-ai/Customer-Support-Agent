import type { SseEnvelope } from "@support-ai/contracts";
import type { ConnectionStatus } from "../types";
import { SseParser, toEnvelope } from "./sse-parser";

export interface StreamOptions {
  url: string;
  token: string;
  /** Resume cursor: the last sequence the UI applied. Re-read on every (re)connect. */
  getLastSequence: () => number;
  onEvent: (e: SseEnvelope) => void;
  onStatus: (s: ConnectionStatus) => void;
  /** An unauthorized stream will never succeed by retrying. */
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
  /** Reconnect delays: 1s, 2s, 4s ... capped. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** No bytes (not even a heartbeat) for this long = dead connection. The server pings every 15s. */
  idleTimeoutMs?: number;
}

export interface EventStream {
  close(): void;
}

/**
 * Authenticated fetch-based SSE. (Native EventSource cannot send an Authorization header, and putting the token in
 * a URL would leak it into logs.) Reconnects with exponential backoff, resuming from the last applied sequence via
 * Last-Event-ID, and detects silent connection loss with an idle watchdog.
 */
export function createEventStream(o: StreamOptions): EventStream {
  const fetchImpl = o.fetchImpl ?? fetch;
  const base = o.baseDelayMs ?? 1000;
  const max = o.maxDelayMs ?? 15_000;
  const idleTimeout = o.idleTimeoutMs ?? (Number(process.env.NEXT_PUBLIC_SSE_IDLE_TIMEOUT_MS) || 45_000);
  let closed = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;

  const loop = async () => {
    while (!closed) {
      controller = new AbortController();
      const local = controller;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => local.abort(), idleTimeout);
      };
      try {
        o.onStatus(attempt === 0 ? "connecting" : "reconnecting");
        const last = o.getLastSequence();
        const res = await fetchImpl(o.url, { headers: { authorization: `Bearer ${o.token}`, accept: "text/event-stream", ...(last > 0 ? { "last-event-id": String(last) } : {}) }, signal: local.signal, cache: "no-store" });
        if (res.status === 401 || res.status === 403) {
          o.onStatus("disconnected");
          o.onUnauthorized?.();
          return;
        }
        if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
        o.onStatus("connected");
        attempt = 0;
        arm();
        const parser = new SseParser();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
            const env = toEnvelope(frame);
            if (env) o.onEvent(env);
          }
        }
      } catch {
        // network error, abort from the idle watchdog, or server closed: fall through to reconnect
      } finally {
        clearTimeout(idle);
      }
      if (closed) return;
      o.onStatus("reconnecting");
      const delay = Math.min(max, base * 2 ** attempt++);
      await new Promise<void>((r) => {
        wake = r;
        timer = setTimeout(r, delay);
      });
      wake = undefined;
    }
  };

  // The browser knows before any timeout does: drop a stream that can no longer deliver, and retry the moment we are back.
  const onOffline = () => controller?.abort();
  const onOnline = () => {
    clearTimeout(timer);
    wake?.();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
  }
  void loop();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      if (typeof window !== "undefined") {
        window.removeEventListener("offline", onOffline);
        window.removeEventListener("online", onOnline);
      }
      wake?.();
      controller?.abort();
      o.onStatus("disconnected");
    },
  };
}
