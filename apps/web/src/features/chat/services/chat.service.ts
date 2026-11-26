import { sendAgentMessageSchema, type AcceptedMessage, type ResumeRunInput } from "@support-ai/contracts";
import { request } from "./api.client";

/** All mutations go through REST; the results arrive on the event stream. */
export const sendMessage = (sessionId: string, token: string, message: string, clientMessageId: string) =>
  request<AcceptedMessage>(`/sessions/${sessionId}/messages`, { token, method: "POST", body: sendAgentMessageSchema.parse({ message, clientMessageId, mode: "chat" }) });

export const resumeRun = (runId: string, token: string, input: ResumeRunInput) => request<AcceptedMessage>(`/runs/${runId}/resume`, { token, method: "POST", body: input });
export const cancelRun = (runId: string, token: string) => request<{ cancelRequested: true }>(`/runs/${runId}/cancel`, { token, method: "POST" });
