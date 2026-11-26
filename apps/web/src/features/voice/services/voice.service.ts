import type { VoiceSessionView } from "@support-ai/contracts";
import { z } from "zod";
import { API_URL, request } from "@/features/chat/services/api.client";

const view = z.object({
  sessionId: z.string(), voiceSessionId: z.string(), status: z.string(), websocketPath: z.string(), ticket: z.string().optional(), ticketExpiresAt: z.string().optional(),
  maxSessionMinutes: z.number(), audio: z.object({ inputSampleRate: z.number(), outputSampleRate: z.number(), chunkDurationMs: z.number() }),
}) as unknown as z.ZodType<VoiceSessionView>;

export const createVoiceSession = (sessionId: string, token: string) =>
  request<VoiceSessionView>(`/sessions/${sessionId}/voice`, { token, method: "POST", body: { clientConnectionId: crypto.randomUUID(), language: "en" }, schema: view });
export const reconnectVoiceSession = (voiceSessionId: string, token: string) => request<VoiceSessionView>(`/voice/${voiceSessionId}/reconnect`, { token, method: "POST", schema: view });
export const endVoiceSession = (sessionId: string, token: string) => request<{ ended: boolean }>(`/sessions/${sessionId}/voice`, { token, method: "DELETE" });

/** The WebSocket lives on the API origin (not under /v1): ws(s)://host/ws/voice. */
export const voiceSocketUrl = (path: string): string => `${new URL(API_URL).origin.replace(/^http/, "ws")}${path}`;
