import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "public/worklets/capture.worklet.js"), "utf8");

/** Loads the real worklet file against stubs for the AudioWorklet globals. */
function load(sampleRateHz: number, processorOptions: Record<string, unknown> = {}) {
  let Ctor: new (o: unknown) => { process(i: Float32Array[][]): boolean; port: { postMessage: unknown; onmessage: ((e: unknown) => void) | null } };
  class Base { port = { postMessage: (_m: unknown, _t?: unknown) => undefined, onmessage: null as ((e: unknown) => void) | null }; }
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", source)(Base, (_n: string, c: typeof Ctor) => { Ctor = c; }, sampleRateHz);
  const posted: Array<{ buffer: ArrayBuffer; rms: number }> = [];
  const p = new Ctor!({ processorOptions: { outputSampleRate: 16000, chunkMs: 40, ...processorOptions } });
  p.port.postMessage = (m: { type: string; buffer: ArrayBuffer; rms: number }) => posted.push(m);
  const feed = (samples: Float32Array) => { for (let i = 0; i < samples.length; i += 128) p.process([[samples.subarray(i, i + 128)]]); };
  return { p, posted, feed };
}

const sine = (rate: number, hz: number, seconds: number, amp = 0.5) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));
const crossings = (pcm: Int16Array) => { let n = 0; for (let i = 1; i < pcm.length; i++) if ((pcm[i - 1]! < 0) !== (pcm[i]! < 0)) n++; return n; };

describe("capture worklet", () => {
  it.each([48000, 44100, 16000])("emits 40 ms / 1280-byte PCM16 chunks at 16 kHz from a %i Hz context", (rate) => {
    const { posted, feed } = load(rate);
    feed(sine(rate, 440, 1));
    expect(posted.length).toBeGreaterThanOrEqual(24);
    expect(posted.length).toBeLessThanOrEqual(25);
    for (const m of posted) expect(m.buffer.byteLength).toBe(1280);
  });

  it("preserves the tone (440 Hz stays 440 Hz) and the amplitude after resampling", () => {
    const { posted, feed } = load(48000);
    feed(sine(48000, 440, 1, 0.5));
    const all = new Int16Array(posted.flatMap((m) => [...new Int16Array(m.buffer)]));
    // 440 Hz over ~1 s has ~880 zero crossings.
    expect(crossings(all)).toBeGreaterThan(850);
    expect(crossings(all)).toBeLessThan(910);
    const peak = Math.max(...all.map(Math.abs));
    expect(peak).toBeGreaterThan(0.45 * 32767);
    expect(peak).toBeLessThanOrEqual(32767);
  });

  it("downmixes stereo to mono", () => {
    const { p, posted } = load(16000);
    const l = new Float32Array(128).fill(0.5), r = new Float32Array(128).fill(-0.5);
    for (let i = 0; i < 10; i++) p.process([[l, r]]);
    expect(posted.length).toBeGreaterThan(0);
    expect(new Int16Array(posted[0]!.buffer).every((v) => Math.abs(v) <= 1)).toBe(true);
  });

  it("stops posting audio when disabled (mute) and resumes afterwards", () => {
    const { p, posted, feed } = load(16000);
    p.port.onmessage?.({ data: { type: "enable", value: false } });
    feed(sine(16000, 300, 0.5));
    expect(posted).toHaveLength(0);
    p.port.onmessage?.({ data: { type: "enable", value: true } });
    feed(sine(16000, 300, 0.5));
    expect(posted.length).toBeGreaterThan(5);
  });

  it("reports a real RMS level for the chunk and clips out-of-range input", () => {
    const { posted, feed } = load(16000);
    feed(new Float32Array(1280).fill(2));
    expect(posted[0]!.rms).toBeCloseTo(1, 1);
    expect(new Int16Array(posted[0]!.buffer)[0]).toBe(32767);
  });
});
