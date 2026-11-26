import type { SseEnvelope } from "@support-ai/contracts";
import { describe, expect, it, vi } from "vitest";
import { createEventStream } from "./streaming.service";

const env = (sequence: number): SseEnvelope => ({ eventId: `s:${sequence}`, sessionId: "s", runId: "r", sequence, type: "run.started", timestamp: "t", payload: {} });
const frame = (e: SseEnvelope) => `id: ${e.sequence}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/** A fetch whose body yields the given chunks, then either ends or stays open until aborted. */
function streamResponse(chunks: string[], { hang = false, signal }: { hang?: boolean; signal?: AbortSignal } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((c) => controller.enqueue(enc.encode(c)));
      if (!hang) controller.close();
      else signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("createEventStream", () => {
  it("authenticates with a bearer header, parses events and reports connection status", async () => {
    const events: SseEnvelope[] = [];
    const statuses: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => streamResponse([frame(env(1)), frame(env(2))], { hang: true, signal: init?.signal as AbortSignal }));
    const s = createEventStream({ url: "http://x/events", token: "tok", getLastSequence: () => 0, onEvent: (e) => events.push(e), onStatus: (x) => statuses.push(x), fetchImpl: fetchImpl as never });
    await until(() => events.length === 2);
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ authorization: "Bearer tok" });
    expect((fetchImpl.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty("last-event-id");
    expect(statuses).toEqual(["connecting", "connected"]);
    s.close();
  });

  it("reconnects after the connection drops, resuming from the last applied sequence", async () => {
    let applied = 0;
    const events: number[] = [];
    const statuses: string[] = [];
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      calls.push(init!);
      return calls.length === 1 ? streamResponse([frame(env(1)), frame(env(2))]) : streamResponse([frame(env(3))], { hang: true, signal: init?.signal as AbortSignal });
    });
    const s = createEventStream({
      url: "u", token: "t", baseDelayMs: 5, getLastSequence: () => applied, fetchImpl: fetchImpl as never, onStatus: (x) => statuses.push(x),
      onEvent: (e) => { applied = e.sequence; events.push(e.sequence); },
    });
    await until(() => events.length === 3);
    expect(events).toEqual([1, 2, 3]);
    expect((calls[1]!.headers as Record<string, string>)["last-event-id"]).toBe("2");
    expect(statuses).toContain("reconnecting");
    expect(statuses.at(-1)).toBe("connected");
    s.close();
  });

  it("retries after a network error with backoff", async () => {
    let n = 0;
    const events: number[] = [];
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      if (++n < 3) throw new TypeError("network down");
      return streamResponse([frame(env(1))], { hang: true, signal: init?.signal as AbortSignal });
    });
    const s = createEventStream({ url: "u", token: "t", baseDelayMs: 2, getLastSequence: () => 0, fetchImpl: fetchImpl as never, onStatus: () => {}, onEvent: (e) => events.push(e.sequence) });
    await until(() => events.length === 1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    s.close();
  });

  it("does not retry an unauthorized stream", async () => {
    const onUnauthorized = vi.fn();
    const statuses: string[] = [];
    const fetchImpl = vi.fn(async () => new Response("no", { status: 401 }));
    createEventStream({ url: "u", token: "bad", baseDelayMs: 1, getLastSequence: () => 0, fetchImpl: fetchImpl as never, onStatus: (x) => statuses.push(x), onEvent: () => {}, onUnauthorized });
    await until(() => onUnauthorized.mock.calls.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe("disconnected");
  });

  it("treats a silent connection as dead (idle watchdog) and reconnects", async () => {
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => streamResponse([], { hang: true, signal: init?.signal as AbortSignal }));
    const s = createEventStream({ url: "u", token: "t", baseDelayMs: 2, idleTimeoutMs: 30, getLastSequence: () => 0, fetchImpl: fetchImpl as never, onStatus: () => {}, onEvent: () => {} });
    await until(() => fetchImpl.mock.calls.length >= 2);
    s.close();
  });

  it("ignores malformed frames and stops cleanly on close", async () => {
    const events: number[] = [];
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => streamResponse(["id: 9\nevent: run.started\ndata: {broken\n\n", frame(env(4))], { hang: true, signal: init?.signal as AbortSignal }));
    const statuses: string[] = [];
    const s = createEventStream({ url: "u", token: "t", getLastSequence: () => 0, fetchImpl: fetchImpl as never, onStatus: (x) => statuses.push(x), onEvent: (e) => events.push(e.sequence) });
    await until(() => events.length === 1);
    s.close();
    expect(events).toEqual([4]);
    expect(statuses.at(-1)).toBe("disconnected");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("createEventStream: browser connectivity events", () => {
  it("drops the stream immediately on 'offline' and reconnects as soon as 'online' fires, without waiting for backoff", async () => {
    const statuses: string[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      calls++;
      return streamResponse([], { hang: true, signal: init?.signal as AbortSignal });
    });
    const s = createEventStream({ url: "u", token: "t", baseDelayMs: 60_000, maxDelayMs: 60_000, getLastSequence: () => 0, fetchImpl: fetchImpl as never, onStatus: (x) => statuses.push(x), onEvent: () => {} });
    await until(() => statuses.includes("connected"));
    window.dispatchEvent(new Event("offline"));
    await until(() => statuses.at(-1) === "reconnecting");
    window.dispatchEvent(new Event("online")); // the 60s backoff is skipped
    await until(() => calls >= 2, 1000);
    await until(() => statuses.at(-1) === "connected", 1000);
    s.close();
  });
});
