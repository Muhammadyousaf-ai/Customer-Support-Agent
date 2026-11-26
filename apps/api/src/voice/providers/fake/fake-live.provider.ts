import { SUPPORT_TOOL_NAME } from "../../delegation/support-tool.definition.js";
import type { LiveConnectOptions, LiveProvider, LiveSession, ProviderEvent } from "../live-provider.js";

export interface FakeOptions {
  /** What the "customer" says, one entry per detected utterance (in order, cycling). */
  utterances?: string[];
  /** Silence after loud audio that ends an utterance (stands in for server-side VAD). */
  endOfSpeechMs?: number;
  frameMs?: number;
  /** "delegate" (default) calls the support function; "skip" answers on its own to exercise the grounding gate. */
  behavior?: "delegate" | "skip";
  /** What a misbehaving model says instead of the approved text (to exercise grounding correction). */
  misstate?: string;
}

const rms = (b: Buffer): number => {
  let sum = 0;
  const n = b.length >> 1;
  for (let i = 0; i < n; i++) { const v = b.readInt16LE(i * 2); sum += v * v; }
  return n ? Math.sqrt(sum / n) : 0;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A scripted stand-in for OpenAI Realtime. It detects speech from microphone energy, "transcribes" scripted utterances,
 * calls the support function, and speaks the approved answer as a synthesized tone with word-by-word transcription.
 * Used by the test suite and by `VOICE_PROVIDER=fake` so the whole stack can be exercised without a key.
 * Tests can also drive it directly through `emit` and inspect everything sent to it.
 */
export class FakeLiveProvider implements LiveProvider {
  readonly name = "fake";
  readonly model = "fake-live";
  readonly sessions: FakeLiveSession[] = [];
  connectError: Error | null = null;
  /** When set, new sessions never send `ready` (setup timeout tests). */
  neverReady = false;
  /** Handles the fake accepts when resuming. */
  validHandles = new Set<string>();

  constructor(readonly opts: FakeOptions = {}) {}

  get last(): FakeLiveSession {
    return this.sessions[this.sessions.length - 1]!;
  }

  async connect(o: LiveConnectOptions): Promise<LiveSession> {
    if (this.connectError) throw this.connectError;
    if (o.resumptionHandle && !this.validHandles.has(o.resumptionHandle)) throw new Error("invalid resumption handle");
    const s = new FakeLiveSession(this.opts, o, this.neverReady);
    this.sessions.push(s);
    return s;
  }
}

export class FakeLiveSession implements LiveSession {
  readonly audioIn: Buffer[] = [];
  readonly toolResponses: Array<{ id: string; name: string; response: Record<string, unknown> }> = [];
  readonly texts: string[] = [];
  closed = false;
  private n = 0;
  private userSpeaking = false;
  private endTimer: NodeJS.Timeout | undefined;
  private speakToken = 0;
  private speaking = false;

  constructor(private readonly opts: FakeOptions, private readonly conn: LiveConnectOptions, neverReady: boolean) {
    if (!neverReady) setTimeout(() => this.emit({ type: "ready" }), 5);
  }

  emit(e: ProviderEvent): void {
    if (!this.closed) this.conn.onEvent(e);
  }

  sendAudio(pcm: Buffer): void {
    this.audioIn.push(pcm);
    if (rms(pcm) < 400) return;
    if (!this.userSpeaking) {
      this.userSpeaking = true;
      if (this.speaking) { this.speakToken++; this.speaking = false; this.emit({ type: "interrupted" }); }
    }
    clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => this.endUtterance(), this.opts.endOfSpeechMs ?? 250);
  }

  sendAudioStreamEnd(): void {
    clearTimeout(this.endTimer);
    if (this.userSpeaking) this.endUtterance();
  }

  private endUtterance(): void {
    this.userSpeaking = false;
    const list = this.opts.utterances ?? ["Can you refund my last payment?"];
    const text = list[this.n++ % list.length]!;
    const mid = Math.ceil(text.length / 2);
    this.emit({ type: "inputTranscript", text: text.slice(0, mid) });
    this.emit({ type: "inputTranscript", text: text.slice(mid) });
    if (this.opts.behavior === "skip") {
      void this.speak(this.opts.misstate ?? "Sure, that is all taken care of.");
      return;
    }
    this.emit({ type: "toolCall", calls: [{ id: `call_${this.n}`, name: SUPPORT_TOOL_NAME, args: { request: text } }] });
  }

  sendToolResponse(r: Array<{ id: string; name: string; response: Record<string, unknown> }>): void {
    this.toolResponses.push(...r);
    const answer = String(r[0]?.response.spokenResponse ?? "");
    void this.speak(this.opts.misstate ?? answer);
  }

  sendText(text: string): void {
    this.texts.push(text);
    const m = /"""([\s\S]*)"""/.exec(text);
    if (text.startsWith("Say the following") && m) void this.speak(m[1]!);
  }

  /** Streams a tone plus word transcripts, then turnComplete. An interruption aborts it mid-way. */
  async speak(text: string): Promise<void> {
    const token = ++this.speakToken;
    this.speaking = true;
    const words = text.split(/\s+/).filter(Boolean);
    const frameMs = this.opts.frameMs ?? 20;
    const samples = Math.round(24_000 * (frameMs / 1000));
    let phase = 0;
    for (let i = 0; i < words.length; i++) {
      for (let f = 0; f < 3; f++) {
        if (token !== this.speakToken || this.closed) return;
        const pcm = Buffer.alloc(samples * 2);
        for (let k = 0; k < samples; k++) pcm.writeInt16LE(Math.round(Math.sin(phase += (2 * Math.PI * 220) / 24_000) * 6000), k * 2);
        this.emit({ type: "audio", pcm });
        await sleep(frameMs);
      }
      if (token !== this.speakToken) return;
      this.emit({ type: "outputTranscript", text: `${words[i]} ` });
    }
    if (token !== this.speakToken) return;
    this.speaking = false;
    this.emit({ type: "generationComplete" });
    this.emit({ type: "turnComplete" });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.endTimer);
  }
}
