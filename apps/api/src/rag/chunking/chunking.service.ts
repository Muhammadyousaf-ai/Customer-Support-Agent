import { Injectable } from "@nestjs/common";
import { BILLING_PERIODS, TIERS, type BillingPeriod, type Tier } from "@support-ai/contracts";
import { estimateTokens } from "../text/text-utils.js";
import type { ChunkDraft, ParsedDocument } from "../types/rag.types.js";

export interface ChunkOptions {
  /** Sections longer than this are split. Starting value: top of the 300-500 token range. */
  maxTokens: number;
  /** Tokens carried from the end of one split part into the next (50-80 range). */
  overlapTokens: number;
}
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxTokens: 500, overlapTokens: 60 };

export class ChunkingError extends Error {}

interface Section {
  heading: string;
  lines: string[];
}

function parseList<T extends string>(raw: string, allowed: readonly T[], label: string, where: string): T[] {
  const items = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (items.length === 1 && items[0] === "all") return [...allowed];
  for (const item of items) {
    if (!(allowed as readonly string[]).includes(item)) throw new ChunkingError(`${where}: unknown ${label} "${item}"`);
  }
  return items as T[];
}

/** `<!-- tiers: basic, pro; contracts: monthly -->` directly under a heading. */
function parseSectionMeta(line: string, where: string): { tiers: Tier[]; contracts: BillingPeriod[] } | null {
  const m = /^<!--\s*(.*?)\s*-->$/.exec(line.trim());
  if (!m) return null;
  let tiers: Tier[] = [...TIERS];
  let contracts: BillingPeriod[] = [...BILLING_PERIODS];
  for (const part of m[1]!.split(";")) {
    const kv = /^\s*(tiers|contracts)\s*:\s*(.+)$/.exec(part);
    if (!kv) throw new ChunkingError(`${where}: bad section metadata "${part.trim()}"`);
    if (kv[1] === "tiers") tiers = parseList(kv[2]!, TIERS, "tier", where);
    else contracts = parseList(kv[2]!, BILLING_PERIODS, "contract type", where);
  }
  return { tiers, contracts };
}

/** Split an over-long section on paragraph (then sentence) boundaries, carrying a small overlap between parts. */
export function splitLongText(text: string, { maxTokens, overlapTokens }: ChunkOptions): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];
  const units = text
    .split(/\n{2,}/)
    .flatMap((p) => (estimateTokens(p) <= maxTokens ? [p.trim()] : p.split(/(?<=[.!?])\s+/).map((s) => s.trim())))
    .filter(Boolean);

  const parts: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const unit of units) {
    const t = estimateTokens(unit);
    if (current.length && currentTokens + t > maxTokens) {
      parts.push(current);
      // overlap: trailing units of the previous part that fit in the overlap budget
      const carry: string[] = [];
      let carryTokens = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const ct = estimateTokens(current[i]!);
        if (carryTokens + ct > overlapTokens) break;
        carry.unshift(current[i]!);
        carryTokens += ct;
      }
      current = carry;
      currentTokens = carryTokens;
    }
    current.push(unit);
    currentTokens += t;
  }
  if (current.length) parts.push(current);
  return parts.map((p) => p.join("\n\n"));
}

@Injectable()
export class ChunkingService {
  /** Heading-based chunking: one chunk per `#`/`##` section, split further only when too long. */
  chunk(doc: ParsedDocument, options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): ChunkDraft[] {
    const sections: Section[] = [];
    for (const line of doc.body.split(/\r?\n/)) {
      const h = /^#{1,2}\s+(.+?)\s*$/.exec(line);
      if (h) sections.push({ heading: h[1]!, lines: [] });
      else if (sections.length) sections[sections.length - 1]!.lines.push(line);
      else if (line.trim()) sections.push({ heading: "Overview", lines: [line] });
    }

    const chunks: ChunkDraft[] = [];
    for (const section of sections) {
      const where = `${doc.fileName} > ${section.heading}`;
      const lines = [...section.lines];
      const firstIdx = lines.findIndex((l) => l.trim());
      let tiers: Tier[] = [...TIERS];
      let contracts: BillingPeriod[] = [...BILLING_PERIODS];
      if (firstIdx >= 0) {
        const meta = parseSectionMeta(lines[firstIdx]!, where);
        if (meta) {
          tiers = meta.tiers;
          contracts = meta.contracts;
          lines.splice(firstIdx, 1);
        }
      }
      const text = lines.join("\n").trim();
      if (!text) continue;
      const parts = splitLongText(text, options);
      parts.forEach((part, i) => {
        chunks.push({
          chunkIndex: chunks.length,
          heading: section.heading,
          content: part,
          embedText: `${doc.title} - ${section.heading}\n${section.heading}\n${part}`,
          applicableTiers: tiers,
          contractTypes: contracts,
          metadata: {
            fileName: doc.fileName,
            documentTitle: doc.title,
            category: doc.category,
            policyVersion: doc.version,
            tokenEstimate: estimateTokens(part),
            part: i + 1,
            parts: parts.length,
          },
        });
      });
    }
    if (!chunks.length) throw new ChunkingError(`${doc.fileName}: no sections found`);
    return chunks;
  }
}
