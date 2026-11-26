export type MicrophoneErrorCode = "PERMISSION_DENIED" | "NO_DEVICE" | "UNSUPPORTED" | "CLIENT";
export class MicrophoneError extends Error {
  constructor(readonly code: MicrophoneErrorCode, message: string) {
    super(message);
  }
}

export interface MicrophoneOptions {
  outputSampleRate: number;
  chunkMs: number;
  /** One call per chunk: signed 16-bit little-endian mono PCM at `outputSampleRate`. */
  onFrame: (pcm: ArrayBuffer) => void;
  workletUrl?: string;
}

/**
 * Captures the microphone with the MediaDevices API and processes it in an AudioWorklet (never MediaRecorder).
 * The worklet resamples to 16 kHz mono PCM16 in 40 ms chunks.
 */
export class Microphone {
  private constructor(
    private readonly stream: MediaStream,
    private readonly ctx: AudioContext,
    private readonly node: AudioWorkletNode,
    readonly analyser: AnalyserNode,
  ) {}

  static async open(o: MicrophoneOptions): Promise<Microphone> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
      throw new MicrophoneError("UNSUPPORTED", "This browser does not support live voice. You can continue in chat.");
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "NotAllowedError" || name === "SecurityError") throw new MicrophoneError("PERMISSION_DENIED", "Microphone access was blocked. Allow it in your browser, or continue in chat.");
      if (name === "NotFoundError" || name === "OverconstrainedError") throw new MicrophoneError("NO_DEVICE", "No microphone was found. Connect one, or continue in chat.");
      throw new MicrophoneError("CLIENT", "The microphone could not be started.");
    }
    const ctx = new AudioContext();
    try {
      if (ctx.state === "suspended") await ctx.resume();
      await ctx.audioWorklet.addModule(o.workletUrl ?? "/worklets/capture.worklet.js");
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "capture-processor", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit", processorOptions: { outputSampleRate: o.outputSampleRate, chunkMs: o.chunkMs } });
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(node);
      source.connect(analyser);
      node.port.onmessage = (e: MessageEvent<{ type: string; buffer: ArrayBuffer }>) => { if (e.data?.type === "pcm") o.onFrame(e.data.buffer); };
      return new Microphone(stream, ctx, node, analyser);
    } catch (err) {
      for (const t of stream.getTracks()) t.stop();
      await ctx.close().catch(() => undefined);
      throw new MicrophoneError("CLIENT", err instanceof Error ? err.message : "The microphone could not be started.");
    }
  }

  /** Disabling stops chunks at the source (and silences the track), so muted audio never leaves the page. */
  setEnabled(enabled: boolean): void {
    this.node.port.postMessage({ type: "enable", value: enabled });
    for (const t of this.stream.getAudioTracks()) t.enabled = enabled;
  }

  async stop(): Promise<void> {
    this.node.port.onmessage = null;
    try { this.node.disconnect(); this.analyser.disconnect(); } catch { /* ignore */ }
    for (const t of this.stream.getTracks()) t.stop();
    if (this.ctx.state !== "closed") await this.ctx.close().catch(() => undefined);
  }
}
