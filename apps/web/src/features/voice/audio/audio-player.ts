import { pcm16ToFloat32 } from "./pcm";

export interface PlayerOptions {
  sampleRate?: number;
  /** Audio is scheduled this far ahead of the first chunk of an utterance so network jitter does not cause gaps. */
  initialBufferMs?: number;
  /** Hard bound on scheduled-but-unplayed audio. Beyond it new chunks are dropped instead of growing latency. */
  maxQueuedMs?: number;
  createContext?: () => AudioContext;
  onStarted?: (generationId: number) => void;
  onIdle?: (generationId: number) => void;
}

export type EnqueueResult = "queued" | "stale" | "duplicate" | "overflow";

interface Scheduled { src: AudioBufferSourceNode; generationId: number; endsAt: number }

/**
 * Plays streamed PCM16 gaplessly with an AudioBufferSourceNode scheduler. Each chunk is scheduled to start exactly
 * where the previous one ends. Every chunk carries the audio generation it belongs to: after an interruption the
 * generation advances, the queue is cleared, and anything still arriving for the old generation is rejected.
 * `isPlaying` reports what the speaker is actually doing, not what the provider is generating.
 */
export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private _analyser: AnalyserNode | null = null;
  private generation = 1;
  private lastSequence = 0;
  private nextStart = 0;
  private active = new Set<Scheduled>();
  private playing = false;
  private startedTimer: ReturnType<typeof setTimeout> | null = null;
  stats = { stale: 0, overflow: 0, underruns: 0, chunks: 0 };

  constructor(private readonly o: PlayerOptions = {}) {}

  async init(): Promise<void> {
    if (this.ctx) return;
    this.ctx = this.o.createContext ? this.o.createContext() : new AudioContext();
    this.gain = this.ctx.createGain();
    this._analyser = this.ctx.createAnalyser();
    this._analyser.fftSize = 1024;
    this.gain.connect(this._analyser);
    this._analyser.connect(this.ctx.destination);
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  get analyser(): AnalyserNode | null { return this._analyser; }
  get isPlaying(): boolean { return this.playing; }
  get currentGeneration(): number { return this.generation; }
  /** Milliseconds of audio scheduled but not yet played. */
  get queuedMs(): number { return this.ctx ? Math.max(0, (this.nextStart - this.ctx.currentTime) * 1000) : 0; }

  enqueue(generationId: number, sequence: number, pcm: Uint8Array): EnqueueResult {
    const ctx = this.ctx;
    if (!ctx || !this.gain) return "stale";
    if (generationId < this.generation) { this.stats.stale += 1; return "stale"; }
    if (generationId > this.generation) this.setGeneration(generationId);
    if (sequence <= this.lastSequence) return "duplicate";
    if (this.queuedMs > (this.o.maxQueuedMs ?? 8000)) { this.stats.overflow += 1; return "overflow"; }
    this.lastSequence = sequence;

    const samples = pcm16ToFloat32(pcm);
    if (!samples.length) return "queued";
    const rate = this.o.sampleRate ?? 24_000;
    const buffer = ctx.createBuffer(1, samples.length, rate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);

    const now = ctx.currentTime;
    if (this.nextStart <= now) {
      if (this.playing && this.active.size === 0) this.stats.underruns += 1; // we ran dry while the assistant was still talking
      this.nextStart = now + (this.o.initialBufferMs ?? 100) / 1000;
    }
    const startAt = this.nextStart;
    const duration = samples.length / rate;
    this.nextStart = startAt + duration;
    const item: Scheduled = { src, generationId, endsAt: this.nextStart };
    this.active.add(item);
    src.onended = () => {
      this.active.delete(item);
      if (this.active.size === 0 && this.playing && item.generationId === this.generation) {
        this.playing = false;
        this.o.onIdle?.(item.generationId);
      }
    };
    src.start(startAt);
    this.stats.chunks += 1;

    if (!this.playing) {
      this.playing = true;
      const delay = Math.max(0, (startAt - now) * 1000);
      const gen = generationId;
      this.startedTimer = setTimeout(() => { if (this.generation === gen && this.playing) this.o.onStarted?.(gen); }, delay);
    }
    return "queued";
  }

  /** Interruption: stop everything now and reject audio from older generations from here on. */
  setGeneration(generationId: number): void {
    this.generation = Math.max(this.generation, generationId);
    this.clear();
  }

  clear(): void {
    if (this.startedTimer) clearTimeout(this.startedTimer);
    this.startedTimer = null;
    for (const s of this.active) {
      s.src.onended = null;
      try { s.src.stop(); } catch { /* not started yet or already ended */ }
      try { s.src.disconnect(); } catch { /* ignore */ }
    }
    this.active.clear();
    this.nextStart = 0;
    this.lastSequence = 0;
    this.playing = false;
  }

  async dispose(): Promise<void> {
    this.clear();
    try { this.gain?.disconnect(); this._analyser?.disconnect(); } catch { /* ignore */ }
    const ctx = this.ctx;
    this.ctx = null;
    this.gain = null;
    this._analyser = null;
    if (ctx && ctx.state !== "closed") await ctx.close().catch(() => undefined);
  }
}
