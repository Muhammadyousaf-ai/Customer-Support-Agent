/**
 * Linear-interpolation resampler for mono PCM16 little-endian.
 * ponytail: per-chunk, no state across chunk boundaries (one-sample seam every chunk); good enough for speech recognition.
 * Use a stateful polyphase filter if audio quality on the model side ever matters.
 */
export function upsamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate || pcm.length < 2) return pcm;
  const n = pcm.length >> 1;
  const outN = Math.round((n * toRate) / fromRate);
  const out = Buffer.alloc(outN * 2);
  const step = fromRate / toRate;
  for (let i = 0; i < outN; i++) {
    const pos = i * step;
    const j = Math.floor(pos);
    const a = pcm.readInt16LE(Math.min(j, n - 1) * 2);
    const b = pcm.readInt16LE(Math.min(j + 1, n - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * (pos - j)), i * 2);
  }
  return out;
}
