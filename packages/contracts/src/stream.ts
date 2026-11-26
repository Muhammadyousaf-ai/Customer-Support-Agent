import { z } from "zod";
import { AGENT_EVENT_TYPES, type AgentEvent, type AgentEventType } from "./events.js";

/** What goes over the wire on the SSE stream (the SSE `id:` field carries `sequence`). */
export interface SseEnvelope<T = unknown> {
  eventId: string;
  sessionId: string;
  runId: string;
  /** Monotonic per session. Clients resume with Last-Event-ID = the last sequence they processed. */
  sequence: number;
  type: AgentEventType;
  timestamp: string;
  payload: T;
}

export const sseEnvelopeSchema = z.object({
  eventId: z.string(),
  sessionId: z.string(),
  runId: z.string(),
  sequence: z.number().int().nonnegative(),
  type: z.enum(AGENT_EVENT_TYPES),
  timestamp: z.string(),
  payload: z.unknown(),
});

export function toEnvelope(e: AgentEvent): SseEnvelope {
  const sequence = e.sessionSeq ?? 0;
  return { eventId: `${e.sessionId}:${sequence}`, sessionId: e.sessionId, runId: e.runId, sequence, type: e.type, timestamp: e.ts, payload: e.data };
}
