import { sseEnvelopeSchema, type SseEnvelope } from "@support-ai/contracts";

export interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  /** Comment lines (": ping"), used only as liveness signals. */
  comment?: string;
  retry?: number;
}

/**
 * Incremental parser for the text/event-stream format. Feed it chunks as they arrive; it returns complete frames.
 * Handles chunk boundaries anywhere (even inside a field), CRLF, multi-line data and comment lines.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buffer);
      if (!m) break;
      const block = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const frame = parseBlock(block);
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

function parseBlock(block: string): SseFrame | null {
  const frame: SseFrame = {};
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith(":")) {
      frame.comment = line.slice(1).trim();
      continue;
    }
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "id") frame.id = value;
    else if (field === "event") frame.event = value;
    else if (field === "data") data.push(value);
    else if (field === "retry" && /^\d+$/.test(value)) frame.retry = Number(value);
  }
  if (data.length) frame.data = data.join("\n");
  return frame.id !== undefined || frame.event !== undefined || frame.data !== undefined || frame.comment !== undefined || frame.retry !== undefined ? frame : null;
}

/** Validates a data frame into a typed envelope; malformed frames return null (and are ignored by the caller). */
export function toEnvelope(frame: SseFrame): SseEnvelope | null {
  if (frame.data === undefined) return null;
  try {
    const parsed = sseEnvelopeSchema.safeParse(JSON.parse(frame.data));
    return parsed.success ? (parsed.data as SseEnvelope) : null;
  } catch {
    return null;
  }
}
