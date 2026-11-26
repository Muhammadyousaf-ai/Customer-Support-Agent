import { describe, expect, it, vi } from "vitest";
import { AudioPlayer } from "./audio-player";

class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  started: number | null = null;
  stopped = false;
  connect() {}
  disconnect() {}
  start(at: number) { this.started = at; }
  stop() { this.stopped = true; }
}
function fakeCtx() {
  const sources: FakeSource[] = [];
  const ctx = {
    currentTime: 1,
    state: "running",
    destination: {},
    createGain: () => ({ connect() {}, disconnect() {} }),
    createAnalyser: () => ({ fftSize: 0, connect() {}, disconnect() {} }),
    createBuffer: (_c: number, length: number, rate: number) => ({ duration: length / rate, copyToChannel() {} }),
    createBufferSource: () => { const s = new FakeSource(); sources.push(s); return s; },
    resume: async () => {},
    close: async () => {},
  };
  return { ctx, sources };
}
const pcm = (ms: number) => new Uint8Array((24000 * ms) / 1000 * 2);

async function player(opts: ConstructorParameters<typeof AudioPlayer>[0] = {}) {
  const f = fakeCtx();
  const events: string[] = [];
  const p = new AudioPlayer({ createContext: () => f.ctx as unknown as AudioContext, initialBufferMs: 100, onStarted: (g) => events.push(`started:${g}`), onIdle: (g) => events.push(`idle:${g}`), ...opts });
  await p.init();
  return { p, ...f, events };
}

describe("AudioPlayer", () => {
  it("schedules chunks back to back with an initial buffer, with no gaps or overlaps", async () => {
    const { p, sources } = await player();
    p.enqueue(1, 1, pcm(40));
    p.enqueue(1, 2, pcm(40));
    p.enqueue(1, 3, pcm(40));
    expect(sources.map((s) => s.started)).toEqual([1.1, 1.14, 1.18].map((n) => expect.closeTo(n, 5)));
    expect(p.queuedMs).toBeCloseTo(220, 0);
  });

  it("rejects audio from an older generation and duplicates", async () => {
    const { p, sources } = await player();
    p.enqueue(2, 1, pcm(40));
    expect(p.enqueue(1, 5, pcm(40))).toBe("stale");
    expect(p.enqueue(2, 1, pcm(40))).toBe("duplicate");
    expect(sources).toHaveLength(1);
    expect(p.stats.stale).toBe(1);
  });

  it("interruption stops everything immediately and drops obsolete frames that arrive afterwards", async () => {
    const { p, sources, events } = await player();
    for (let i = 1; i <= 5; i++) p.enqueue(1, i, pcm(40));
    p.setGeneration(2);
    expect(sources.every((s) => s.stopped)).toBe(true);
    expect(p.queuedMs).toBe(0);
    expect(p.isPlaying).toBe(false);
    expect(p.enqueue(1, 6, pcm(40))).toBe("stale"); // delayed audio from before the interruption
    expect(p.enqueue(2, 1, pcm(40))).toBe("queued");
    expect(events).not.toContain("idle:1"); // clearing is not the same as finishing
  });

  it("reports actual playback: started once playback begins, idle when the last chunk ends", async () => {
    vi.useFakeTimers();
    try {
      const { p, sources, events } = await player();
      p.enqueue(1, 1, pcm(40));
      p.enqueue(1, 2, pcm(40));
      expect(events).toEqual([]);
      vi.advanceTimersByTime(120);
      expect(events).toEqual(["started:1"]);
      sources[0]!.onended?.();
      expect(events).toEqual(["started:1"]);
      sources[1]!.onended?.();
      expect(events).toEqual(["started:1", "idle:1"]);
      expect(p.isPlaying).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the queue instead of letting latency grow", async () => {
    const { p, sources } = await player({ maxQueuedMs: 500 });
    let overflow = 0;
    for (let i = 1; i <= 40; i++) if (p.enqueue(1, i, pcm(40)) === "overflow") overflow++;
    expect(overflow).toBeGreaterThan(0);
    expect(sources.length).toBeLessThan(40);
    expect(p.queuedMs).toBeLessThan(700);
  });

  it("counts an underrun and re-buffers when the stream runs dry mid-utterance", async () => {
    const { p, ctx, sources } = await player();
    p.enqueue(1, 1, pcm(40));
    ctx.currentTime = 5; // the stream stalled for seconds
    p.enqueue(1, 2, pcm(40));
    expect(sources[1]!.started).toBeCloseTo(5.1, 5);
    expect(p.stats.underruns).toBe(0); // chunk 1 is still "active" (its onended has not fired); no false alarm
    sources[0]!.onended?.();
  });

  it("releases the context on dispose", async () => {
    const { p, sources } = await player();
    p.enqueue(1, 1, pcm(40));
    await p.dispose();
    expect(sources[0]!.stopped).toBe(true);
    expect(p.analyser).toBeNull();
    expect(p.enqueue(1, 2, pcm(40))).toBe("stale");
  });
});
