import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { ToolCall } from "../registry/tool-definition.interface.js";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

@Injectable()
export class IdempotencyService {
  /**
   * Same logical operation => same key. Scoped to session and tool so keys cannot collide across customers.
   * The business tables enforce the key with a UNIQUE constraint, so retries and races return the original result.
   */
  keyFor(call: ToolCall, toolName: string, input: unknown): string {
    if (call.idempotencyKey) return `${call.sessionId}:${toolName}:${call.idempotencyKey}`;
    const digest = createHash("sha256").update(`${call.sessionId}|${toolName}|${canonicalJson(input)}`).digest("hex");
    return `${call.sessionId}:${toolName}:${digest.slice(0, 32)}`;
  }
}
