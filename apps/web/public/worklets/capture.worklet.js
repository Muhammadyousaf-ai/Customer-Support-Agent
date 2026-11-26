/**
 * Microphone capture worklet (runs on the audio rendering thread).
 * Downmixes to mono, resamples from the context rate (usually 44.1 or 48 kHz) to the target rate (16 kHz) with an
 * area-averaging filter (a box low-pass, so speech does not alias), converts to signed 16-bit little-endian PCM and posts
 * fixed-size chunks (default 40 ms = 640 samples = 1,280 bytes) to the main thread. Plain JS, no imports: it is loaded
 * with audioWorklet.addModule() and unit-tested by evaluating this file against stubs.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.outRate = o.outputSampleRate || 16000;
    this.chunkSamples = Math.max(1, Math.round((this.outRate * (o.chunkMs || 40)) / 1000));
    this.ratio = sampleRate / this.outRate;
    this.pos = 0; // input sample index
    this.boundary = this.ratio; // input position at which the current output sample is complete
    this.acc = 0;
    this.weight = 0;
    this.buf = new Int16Array(this.chunkSamples);
    this.n = 0;
    this.sumSq = 0;
    this.enabled = true;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "enable") this.enabled = Boolean(e.data.value);
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const channels = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let x = 0;
      for (let c = 0; c < channels; c++) x += input[c][i];
      this.push(x / channels);
    }
    return true;
  }

  push(x) {
    const end0 = this.pos + 1;
    let start = this.pos;
    while (start < end0) {
      const end = Math.min(end0, this.boundary);
      this.acc += x * (end - start);
      this.weight += end - start;
      start = end;
      if (end >= this.boundary - 1e-9) {
        this.emit(this.acc / this.weight);
        this.acc = 0;
        this.weight = 0;
        this.boundary += this.ratio;
      }
    }
    this.pos = end0;
  }

  emit(v) {
    const c = v > 1 ? 1 : v < -1 ? -1 : v;
    this.buf[this.n++] = c < 0 ? Math.round(c * 32768) : Math.round(c * 32767);
    this.sumSq += c * c;
    if (this.n === this.chunkSamples) {
      if (this.enabled) {
        const out = this.buf.slice(0).buffer;
        this.port.postMessage({ type: "pcm", buffer: out, rms: Math.sqrt(this.sumSq / this.chunkSamples) }, [out]);
      }
      this.n = 0;
      this.sumSq = 0;
    }
  }
}

registerProcessor("capture-processor", CaptureProcessor);
