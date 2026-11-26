import { Logger } from "@nestjs/common";
import { loadEnv } from "../config/env.js";

const logger = new Logger("LlmHttp");

export class OpenAiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface OpenAiRequestOptions {
  apiKey: string;
  timeoutMs?: number;
  retries?: number;
  baseUrl?: string;
  /** Caller abort (cancellation / deadline). Aborting stops the request and any further retries. */
  signal?: AbortSignal;
}

interface ResponseShape {
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string } }> } }>;
  data?: unknown[];
}

/** What the model answered, without its text: tool names, answer length, token counts. */
function summarize(r: ResponseShape): string {
  const msg = r.choices?.[0]?.message;
  const tools = msg?.tool_calls?.map((c) => c.function?.name).filter(Boolean);
  return [
    tools?.length ? `tool_call ${tools.join(", ")}` : msg ? `text ${msg.content?.length ?? 0} chars` : "",
    r.choices?.[0]?.finish_reason ? `finish ${r.choices[0].finish_reason}` : "",
    r.data ? `${r.data.length} vector(s)` : "",
    r.usage ? `tokens ${r.usage.prompt_tokens ?? 0} in / ${r.usage.completion_tokens ?? 0} out` : "",
  ].filter(Boolean).join(" · ");
}

/** Pulls the human-readable message out of an OpenAI error body. */
function providerError(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } } | Array<{ error?: { message?: string } }>;
    const message = Array.isArray(j) ? j[0]?.error?.message : j.error?.message;
    if (message) text = message;
  } catch {
    // not JSON: log as is
  }
  return text.replace(/\s+/g, " ").slice(0, 400);
}

const secs = (since: number) => `${((performance.now() - since) / 1000).toFixed(2)} s`;

/**
 * POST JSON to the OpenAI API with a timeout and bounded retry on 429 / 5xx / network errors.
 * Every attempt is logged with its outcome. Request bodies are not: they carry customer text.
 */
export async function openAiPost<T>(path: string, body: unknown, opts: OpenAiRequestOptions): Promise<T> {
  const { apiKey, timeoutMs = 15_000, retries = 2, baseUrl = loadEnv().OPENAI_BASE_URL, signal } = opts;
  const model = (body as { model?: string }).model ?? "?";
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const tag = `POST ${path} [${model}]${attempt ? ` retry ${attempt}/${retries}` : ""}`;
    const started = performance.now();
    logger.log(`${tag} → sent`);
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const json = (await res.json()) as T;
        logger.log(`${tag} ← ${res.status} · ${secs(started)} · ${summarize(json as ResponseShape)}`);
        return json;
      }
      const retryable = res.status === 429 || res.status >= 500;
      const line = `${tag} ← ${res.status} · ${secs(started)}${retryable && attempt < retries ? " · will retry" : ""}\n    ↳ ${providerError(await res.text().catch(() => ""))}`;
      if (retryable) logger.warn(line);
      else logger.error(line);
      const err = new OpenAiError(`OpenAI ${path} failed with ${res.status}`, res.status);
      if (!retryable) throw err;
      lastError = err;
    } catch (err) {
      if (err instanceof OpenAiError && !(err.status === 429 || (err.status ?? 0) >= 500)) throw err;
      if (!(err instanceof OpenAiError)) {
        const why = signal?.aborted ? "cancelled by caller" : err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        logger.warn(`${tag} ✕ no response · ${secs(started)} (timeout ${timeoutMs / 1000} s)\n    ↳ ${why}`);
      }
      lastError = err;
    }
    if (signal?.aborted) break;
    if (attempt < retries) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new OpenAiError("OpenAI request failed");
}
