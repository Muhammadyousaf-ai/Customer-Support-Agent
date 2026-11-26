import type { z } from "zod";
import type { ChatError } from "../types";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/v1").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export interface RequestOptions<S extends z.ZodType | undefined> {
  token?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Validates the response so a changed backend contract fails loudly instead of corrupting UI state. */
  schema?: S;
  signal?: AbortSignal;
}

/** Central API client: one place for auth headers, error mapping and response validation. */
export async function request<T = unknown>(path: string, o: RequestOptions<z.ZodType<T> | undefined> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: o.method ?? "GET",
      // FormData sets its own multipart boundary header.
      headers: { ...(o.body !== undefined && !(o.body instanceof FormData) ? { "content-type": "application/json" } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
      body: o.body === undefined ? undefined : o.body instanceof FormData ? o.body : JSON.stringify(o.body),
      signal: o.signal,
      cache: "no-store",
    });
  } catch (err) {
    if (o.signal?.aborted) throw err;
    throw new ApiError(0, "Network error. Check your connection.");
  }
  const text = await res.text();
  const json: unknown = text ? safeJson(text) : null;
  if (!res.ok) {
    const message = typeof (json as { message?: unknown })?.message === "string" ? (json as { message: string }).message : `Request failed (${res.status})`;
    const retry = Number(res.headers.get("retry-after"));
    throw new ApiError(res.status, message, Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
  if (!o.schema) return json as T;
  const parsed = o.schema.safeParse(json);
  if (!parsed.success) throw new ApiError(502, "Unexpected response from the server.");
  return parsed.data;
}

const safeJson = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

export function toChatError(err: unknown): ChatError {
  if (err instanceof ApiError) {
    if (err.status === 0) return { kind: "network", message: err.message, retryable: true };
    if (err.status === 401) return { kind: "unauthorized", message: "This conversation is no longer available in this browser.", retryable: false };
    if (err.status === 409) return { kind: "conflict", message: "The agent is still working on your previous message.", retryable: true };
    if (err.status === 429) return { kind: "rate_limited", message: err.message, retryable: true };
    // 503 with a stated reason (daily AI budget used up, or the service restarting) is shown as is: it is actionable.
    if (err.status === 503 && /budget|restarting/i.test(err.message)) return { kind: "server", message: err.message, retryable: false };
    if (err.status >= 500) return { kind: "server", message: "The support agent is having trouble right now.", retryable: true };
    return { kind: "unknown", message: err.message, retryable: false };
  }
  return { kind: "unknown", message: err instanceof Error ? err.message : "Something went wrong.", retryable: true };
}
