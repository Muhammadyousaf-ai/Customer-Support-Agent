import { renameSessionSchema, type AgentRunResponse, type SessionView } from "@support-ai/contracts";
import { z } from "zod";
import { authed, useAuthStore } from "@/features/auth/auth.store";
import { request } from "./api.client";

const created = z.object({ sessionId: z.string(), sessionToken: z.string(), expiresAt: z.string() });
const pending = z.object({ id: z.string(), type: z.enum(["refund", "account_update"]), summary: z.string(), amountCents: z.number().optional(), currency: z.string().optional(), expiresAt: z.string(), display: z.record(z.string(), z.string()) });
const view = z.object({
  id: z.string(), title: z.string(), createdAt: z.string(), updatedAt: z.string(), identityVerified: z.boolean(), lastMessage: z.string().nullable(),
  activeRun: z.object({ runId: z.string(), status: z.string() }).nullable(), pendingAction: pending.nullable(),
});
const message = z.object({ id: z.number(), role: z.enum(["user", "assistant"]), content: z.string(), mode: z.enum(["chat", "voice"]), runId: z.string().nullable(), clientMessageId: z.string().nullable(), createdAt: z.string(), author: z.enum(["ai", "customer", "staff"]).optional() });
export type StoredMessage = z.infer<typeof message>;

/**
 * Signed-in customers get an account-owned conversation (it follows them across devices); anonymous demo visitors still work.
 * Signed-in goes through authed() so an expired access token is refreshed instead of failing (or silently creating an anonymous conversation).
 */
export const createSession = () =>
  useAuthStore.getState().status === "authed" ? authed("/sessions", { method: "POST" }).then((r) => created.parse(r)) : request("/sessions", { method: "POST", schema: created });
export const getSession = (id: string, token: string) => request<SessionView>(`/sessions/${id}`, { token, schema: view as unknown as z.ZodType<SessionView> });
export const renameSession = (id: string, token: string, title: string) => request<SessionView>(`/sessions/${id}`, { token, method: "PATCH", body: renameSessionSchema.parse({ title }), schema: view as unknown as z.ZodType<SessionView> });
/** Signed-in owners use their account token, so these never depend on a per-conversation token this device may have lost. */
export const getOwnSession = (id: string) => authed<SessionView>(`/sessions/${id}`);
export const renameOwnSession = (id: string, title: string) => authed<SessionView>(`/sessions/${id}`, { method: "PATCH", body: renameSessionSchema.parse({ title }) });
export const deleteOwnSession = (id: string) => authed(`/me/sessions/${id}`, { method: "DELETE" });
export const listOwnSessions = () => authed<Array<{ id: string; createdAt: string }>>("/me/sessions");
export const mintSessionToken = (id: string) => authed<{ sessionToken: string }>(`/me/sessions/${id}/token`, { method: "POST" }).then((t) => t.sessionToken);
export const getMessages = (id: string, token: string) => request(`/sessions/${id}/messages`, { token, schema: z.array(message) });
export const getRun = (runId: string, token: string) => request<AgentRunResponse>(`/runs/${runId}`, { token });
