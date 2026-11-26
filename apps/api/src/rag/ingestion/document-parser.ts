import { createHash } from "node:crypto";
import { POLICY_CATEGORIES } from "@support-ai/contracts";
import { z } from "zod";
import type { ParsedDocument } from "../types/rag.types.js";

export class DocumentParseError extends Error {}

const frontmatterSchema = z.object({
  title: z.string().min(1),
  category: z.enum(POLICY_CATEGORIES),
  version: z.string().min(1),
});

/** Minimal `key: value` frontmatter (strings only), delimited by `---` lines. */
export function parseDocument(fileName: string, raw: string): ParsedDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) throw new DocumentParseError(`${fileName}: missing frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv) throw new DocumentParseError(`${fileName}: invalid frontmatter line "${line}"`);
    fields[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  const parsed = frontmatterSchema.safeParse(fields);
  if (!parsed.success) throw new DocumentParseError(`${fileName}: ${z.prettifyError(parsed.error)}`);
  const body = match[2]!.trim();
  if (!body) throw new DocumentParseError(`${fileName}: empty document body`);
  return {
    fileName,
    ...parsed.data,
    body,
    checksum: createHash("sha256").update(raw).digest("hex"),
  };
}
