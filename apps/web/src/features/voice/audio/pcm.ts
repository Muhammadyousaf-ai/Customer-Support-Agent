/** Signed 16-bit little-endian PCM <-> Float32 in [-1, 1]. */
export function pcm16ToFloat32(pcm: Uint8Array): Float32Array {
  const n = pcm.byteLength >> 1;
  const out = new Float32Array(n);
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

export function float32ToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const c = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, Math.round(c < 0 ? c * 32768 : c * 32767), true);
  }
  return out;
}
