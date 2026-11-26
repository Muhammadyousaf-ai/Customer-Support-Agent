import { API_URL } from "@/features/chat/services/api.client";
import type { RunSummary, Traces, VoiceDiagnostics } from "../types";

/** Credentials for inspection: the conversation's own token, plus an optional administrator key for prompt/argument detail. */
export interface ObsAuth { token: string; adminKey?: string }

async function get<T>(path: string, a: ObsAuth): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: { authorization: `Bearer ${a.token}`, ...(a.adminKey ? { "x-admin-key": a.adminKey } : {}) }, cache: "no-store" });
  if (!res.ok) throw Object.assign(new Error(`Request failed (${res.status})`), { status: res.status });
  return (await res.json()) as T;
}

export const getRunHistory = (sessionId: string, a: ObsAuth) => get<RunSummary[]>(`/observability/sessions/${sessionId}/runs`, a);
export const getRunTraces = (runId: string, a: ObsAuth) => get<Traces>(`/observability/runs/${runId}/traces`, a);
export const getVoiceDiagnostics = (voiceSessionId: string, a: ObsAuth) => get<VoiceDiagnostics>(`/observability/voice/${voiceSessionId}/metrics`, a);
