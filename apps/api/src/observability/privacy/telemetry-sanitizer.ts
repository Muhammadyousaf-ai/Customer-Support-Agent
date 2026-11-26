/**
 * Everything that reaches PostgreSQL, logs or the browser from the telemetry layer goes through here first.
 * Redaction happens before persistence, not at display time.
 */
const SECRET_KEY = /(api[-_]?key|authorization|token|secret|password|passwd|credential|cookie|ticket|resumption|handle|verification[-_]?code|^code$|otp)/i;
const EMAIL = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\b/g;
const GEMINI_KEY = /AIza[0-9A-Za-z_-]{30,}/g;
const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]{16,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const CODE6 = /(?<![\d.$,])\b\d{6}\b(?![\d.]|,\d)/g;
const CONN_STRING = /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+/gi;

export interface SanitizeOptions { maxString?: number; maxDepth?: number; maxKeys?: number; maxItems?: number }

export function sanitizeString(s: string, maxString = 4000): string {
  let out = s
    .replace(GEMINI_KEY, "[redacted-key]").replace(OPENAI_KEY, "[redacted-key]").replace(BEARER, "Bearer [redacted]")
    .replace(CONN_STRING, "[redacted-connection]").replace(EMAIL, (_m, first: string, domain: string) => `${first}***@${domain}`)
    .replace(CODE6, "[CODE]");
  if (out.length > maxString) out = `${out.slice(0, maxString)}… [+${out.length - maxString} chars]`;
  return out;
}

export function sanitize(value: unknown, o: SanitizeOptions = {}, depth = 0): unknown {
  const { maxString = 4000, maxDepth = 8, maxKeys = 60, maxItems = 50 } = o;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeString(value, maxString);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: sanitizeString(value.message, 500) }; // never the stack: that is developer-only
  if (depth >= maxDepth) return "[truncated]";
  if (Array.isArray(value)) {
    const items = value.slice(0, maxItems).map((v) => sanitize(v, o, depth + 1));
    return value.length > maxItems ? [...items, `[+${value.length - maxItems} more]`] : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries.slice(0, maxKeys)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : sanitize(v, o, depth + 1);
    if (entries.length > maxKeys) out["…"] = `[+${entries.length - maxKeys} more keys]`;
    return out;
  }
  return String(value);
}

/** Serialized size guard for a stored detail blob. */
export function sanitizeDetail(value: unknown, maxBytes = 24_000): unknown {
  const clean = sanitize(value);
  const text = JSON.stringify(clean) ?? "null";
  return text.length <= maxBytes ? clean : { truncated: true, preview: text.slice(0, maxBytes) };
}
