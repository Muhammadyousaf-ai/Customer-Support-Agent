import { Logger } from "@nestjs/common";
import WebSocket from "ws";
import { SUPPORT_TOOL_NAME } from "../../delegation/support-tool.definition.js";
import type { VoiceConfig } from "../../voice.config.js";
import type { LiveConnectOptions, LiveProvider, LiveSession } from "../live-provider.js";
import { normalizeRealtimeEvent, type RealtimeServerEvent } from "./openai-realtime.events.js";
import { upsamplePcm16 } from "./resample.js";

/** OpenAI Realtime only takes 24 kHz PCM16; the browser captures 16 kHz (see apps/web capture.worklet.js). */
export const REALTIME_RATE = 24_000;

const isRateLimit = (s: string) => /\b429\b|rate.?limit|quota|insufficient_quota/i.test(s);
/** Harmless protocol races (e.g. committing an empty buffer after mute): logged by the provider, not surfaced. */
const IGNORED_ERRORS = new Set(["input_audio_buffer_commit_empty", "response_cancel_not_active", "conversation_already_has_active_response"]);

/**
 * Wraps the OpenAI Realtime WebSocket API behind the provider-neutral LiveProvider interface, so the
 * voice orchestrator (delegation to the backend agent, grounding, interruption, recovery) is unchanged. The API key never
 * leaves this process. No session resumption: a dropped connection is recovered by the orchestrator with a fresh session.
 */
export class OpenAiRealtimeAdapter implements LiveProvider {
  readonly name = "openai";
  private readonly logger = new Logger(OpenAiRealtimeAdapter.name);

  constructor(private readonly cfg: VoiceConfig) {}

  get model(): string {
    return this.cfg.model;
  }

  connect(opts: LiveConnectOptions): Promise<LiveSession> {
    if (!this.cfg.apiKey) return Promise.reject(new Error("OPENAI_API_KEY is not configured"));
    const emit = opts.onEvent;
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.cfg.model)}`, { headers: { Authorization: `Bearer ${this.cfg.apiKey}` } });
    let closed = false;
    let pendingAudio = false; // audio appended that server VAD has not committed yet
    const send = (event: Record<string, unknown>) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify(event));
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    };

    ws.on("message", (raw) => {
      let ev: RealtimeServerEvent;
      try {
        ev = JSON.parse(raw.toString()) as RealtimeServerEvent;
      } catch {
        return;
      }
      if (ev.type === "input_audio_buffer.committed" || ev.type === "input_audio_buffer.speech_stopped") pendingAudio = false;
      if (ev.type === "error") {
        const code = ev.error?.code ?? "";
        if (IGNORED_ERRORS.has(code)) return;
        const message = `${code ? `${code}: ` : ""}${ev.error?.message ?? "provider error"}`;
        emit({ type: "error", message, rateLimited: isRateLimit(message) });
        return;
      }
      try {
        for (const e of normalizeRealtimeEvent(ev)) emit(e);
      } catch (err) {
        this.logger.error(`provider message handler failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    ws.on("close", (code, reason) => {
      if (closed) return;
      closed = true;
      emit({ type: "closed", reason: reason.toString() || `code ${code}`, clean: code === 1000 });
    });

    return new Promise<LiveSession>((resolve, reject) => {
      const fail = (err: Error) => {
        closed = true;
        reject(Object.assign(new Error(err.message), { rateLimited: isRateLimit(err.message) }));
      };
      ws.once("error", fail);
      ws.once("unexpected-response", (_req, res) => fail(new Error(`realtime handshake failed: HTTP ${res.statusCode}`)));
      ws.once("open", () => {
        ws.off("error", fail);
        ws.on("error", (e) => emit({ type: "error", message: e.message, rateLimited: isRateLimit(e.message) }));
        // "ready" is emitted on session.updated (see events), i.e. once this configuration is live.
        send({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: opts.systemInstruction,
            output_modalities: ["audio"],
            audio: {
              input: {
                format: { type: "audio/pcm", rate: REALTIME_RATE },
                transcription: { model: this.cfg.transcriptionModel },
                // Filters background noise before VAD, so small sounds no longer barge in on the assistant.
                noise_reduction: { type: "near_field" },
                // Semantic VAD ends the turn when the customer has finished the thought, not after a fixed silence:
                // "hi ... I want to cancel" stays one turn. Eagerness low = waits longer through mid-sentence pauses.
                turn_detection: { type: "semantic_vad", eagerness: this.cfg.vadEagerness, create_response: true, interrupt_response: true },
              },
              output: { format: { type: "audio/pcm", rate: REALTIME_RATE }, voice: opts.voice },
            },
            tools: [{
              type: "function",
              name: SUPPORT_TOOL_NAME,
              description:
                "Resolve a customer support request using the authoritative backend support agent. Use it for billing, account management, refunds, " +
                "subscription questions, troubleshooting, company policies and for any yes/no answer to a question the agent asked. Pass what the customer said.",
              parameters: { type: "object", properties: { request: { type: "string", description: "The customer's request, in their own words" } }, required: ["request"] },
            }],
            tool_choice: "auto",
          },
        });
        resolve({
          sendAudio: (pcm) => {
            pendingAudio = true;
            send({ type: "input_audio_buffer.append", audio: upsamplePcm16(pcm, this.cfg.inputSampleRate, REALTIME_RATE).toString("base64") });
          },
          // Mic muted mid-utterance: server VAD never hears the trailing silence, so commit and ask for a response ourselves.
          sendAudioStreamEnd: () => {
            if (!pendingAudio) return;
            pendingAudio = false;
            send({ type: "input_audio_buffer.commit" });
            send({ type: "response.create" });
          },
          sendToolResponse: (responses) => {
            for (const r of responses) send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: r.id, output: JSON.stringify(r.response) } });
            send({ type: "response.create" });
          },
          sendText: (text, o) => {
            send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
            if (o?.turnComplete ?? true) send({ type: "response.create" });
          },
          close: () => {
            if (closed) return;
            closed = true;
            try {
              ws.close(1000);
            } catch {
              /* already closed */
            }
          },
        });
      });
    });
  }
}
