import { VOICE_MAX_INPUT_FRAME_BYTES } from "@support-ai/contracts";

export type FrameCheck = { ok: true } | { ok: false; reason: "empty" | "too_large" | "odd_length" };

/** PCM16 mono: an even number of bytes, non-empty, no larger than 200 ms of audio. */
export function validateInputFrame(frame: Uint8Array, maxBytes = VOICE_MAX_INPUT_FRAME_BYTES): FrameCheck {
  if (frame.byteLength === 0) return { ok: false, reason: "empty" };
  if (frame.byteLength > maxBytes) return { ok: false, reason: "too_large" };
  if (frame.byteLength % 2 !== 0) return { ok: false, reason: "odd_length" };
  return { ok: true };
}

/** Token bucket in bytes/second so one session cannot flood the provider (or our memory) faster than the configured rate. */
export class InputBudget {
  private tokens: number;
  private last: number;

  constructor(private readonly bytesPerSec: number, private readonly now: () => number = Date.now) {
    this.tokens = bytesPerSec;
    this.last = now();
  }

  take(bytes: number): boolean {
    const t = this.now();
    this.tokens = Math.min(this.bytesPerSec, this.tokens + ((t - this.last) / 1000) * this.bytesPerSec);
    this.last = t;
    if (this.tokens < bytes) return false;
    this.tokens -= bytes;
    return true;
  }
}

export const pcmDurationMs = (bytes: number, sampleRate: number): number => (bytes / 2 / sampleRate) * 1000;
