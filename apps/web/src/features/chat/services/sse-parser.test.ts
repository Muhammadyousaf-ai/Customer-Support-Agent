import { describe, expect, it } from "vitest";
import { SseParser, toEnvelope } from "./sse-parser";

const env = (sequence: number, type = "run.started", payload: unknown = {}) => ({ eventId: `s:${sequence}`, sessionId: "s", runId: "r", sequence, type, timestamp: "t", payload });
const frame = (e: ReturnType<typeof env>) => `id: ${e.sequence}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

describe("SseParser", () => {
  it("parses complete frames and keeps comments and retry as liveness signals", () => {
    const frames = new SseParser().push(`retry: 3000\n\n: ping 123\n\n${frame(env(1))}`);
    expect(frames.map((f) => [f.retry, f.comment, f.id, f.event])).toEqual([[3000, undefined, undefined, undefined], [undefined, "ping 123", undefined, undefined], [undefined, undefined, "1", "run.started"]]);
  });
  it("handles frames split across arbitrary chunk boundaries", () => {
    const text = frame(env(7, "tool.started", { tool: "x" })) + frame(env(8));
    for (let cut = 1; cut < text.length; cut += 7) {
      const p = new SseParser();
      const got = [...p.push(text.slice(0, cut)), ...p.push(text.slice(cut))];
      expect(got.map((f) => f.id)).toEqual(["7", "8"]);
    }
  });
  it("supports CRLF and multi-line data", () => {
    const f = new SseParser().push("id: 1\r\nevent: x\r\ndata: a\r\ndata: b\r\n\r\n");
    expect(f[0]).toMatchObject({ id: "1", event: "x", data: "a\nb" });
  });
  it("does not emit a partial frame until it is terminated", () => {
    const p = new SseParser();
    expect(p.push("id: 1\nevent: x\ndata: {")).toEqual([]);
    expect(p.push("}\n\n")).toHaveLength(1);
  });
});

describe("toEnvelope", () => {
  it("validates the envelope and rejects malformed or unknown events", () => {
    expect(toEnvelope({ data: JSON.stringify(env(1)) })?.sequence).toBe(1);
    expect(toEnvelope({ data: "{not json" })).toBeNull();
    expect(toEnvelope({ data: JSON.stringify(env(1, "bogus.event")) })).toBeNull();
    expect(toEnvelope({ data: JSON.stringify({ sequence: 1 }) })).toBeNull();
    expect(toEnvelope({})).toBeNull();
  });
});
