import { loadEnv } from "../../config/env.js";
import { OpenAiRealtimeAdapter } from "../providers/openai-realtime/openai-realtime.adapter.js";
import type { ProviderEvent } from "../providers/live-provider.js";
import { resolveVoiceConfig } from "../voice.config.js";

/**
 * One short, real OpenAI Realtime round trip: connect, send a text turn, expect transcription and audio back.
 *   pnpm --filter api voice:smoke
 * It costs a few cents at most and tells you whether your key/project can use OPENAI_REALTIME_MODEL and whether the adapter's
 * assumptions (setup, message shapes, audio format) hold. It does not test the microphone, VAD or barge-in.
 */
const cfg = resolveVoiceConfig(loadEnv());
if (!cfg.apiKey) { console.error("No OPENAI_API_KEY configured."); process.exit(2); }
console.log(`model: ${cfg.model}, voice: ${cfg.voice}`);
const events: ProviderEvent[] = [];
const t0 = Date.now();
const times: Record<string, number> = {};
let done: () => void = () => undefined;
const finished = new Promise<void>((r) => { done = r; });
const adapter = new OpenAiRealtimeAdapter(cfg);
try {
  const session = await adapter.connect({
    systemInstruction: "You are a test assistant. Answer in one short sentence.", voice: cfg.voice,
    onEvent: (e) => {
      events.push(e);
      times[e.type] ??= Date.now() - t0;
      if (e.type === "turnComplete" || e.type === "closed" || e.type === "error") done();
    },
  });
  times.connected = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 500));
  session.sendText("Please say hello and tell me one fact about the sea.");
  await Promise.race([finished, new Promise((r) => setTimeout(r, 30_000))]);
  session.close();
} catch (err) {
  console.error("FAILED to connect:", err instanceof Error ? err.message.replace(/sk-[0-9A-Za-z_-]+/g, "[key]") : String(err));
  process.exit(1);
}
const audioBytes = events.filter((e) => e.type === "audio").reduce((n, e) => n + (e as { pcm: Buffer }).pcm.length, 0);
const out = events.filter((e) => e.type === "outputTranscript").map((e) => (e as { text: string }).text).join("");
const usage = events.filter((e) => e.type === "usage").pop();
const problems = events.filter((e) => e.type === "error" || e.type === "closed");
console.log(JSON.stringify({ firstEventsMs: times, audioBytes, audioSecondsAt24k: Number((audioBytes / 2 / cfg.outputSampleRate).toFixed(2)), outputTranscript: out, usage: usage && "usage" in usage ? usage.usage : null, problems: problems.map((p) => ("message" in p ? p.message : p.type === "closed" ? `${p.reason}` : "")).map((m) => m.replace(/sk-[0-9A-Za-z_-]+/g, "[key]").slice(0, 300)) }, null, 2));
process.exit(audioBytes > 0 ? 0 : 1);
