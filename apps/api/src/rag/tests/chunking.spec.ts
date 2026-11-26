import { describe, expect, it } from "vitest";
import { ChunkingError, ChunkingService, splitLongText } from "../chunking/chunking.service.js";
import { parseDocument } from "../ingestion/document-parser.js";
import { estimateTokens } from "../text/text-utils.js";

const doc = (body: string) =>
  parseDocument("t.md", `---\ntitle: Test Policy\ncategory: refund\nversion: "2025-01"\n---\n${body}`);
const chunker = new ChunkingService();

describe("heading-based chunking", () => {
  it("creates one chunk per heading and keeps heading, version and document reference", () => {
    const chunks = chunker.chunk(doc("# General\nAll tiers text.\n\n# Monthly\n<!-- tiers: basic, pro; contracts: monthly -->\nMonthly text."));
    expect(chunks.map((c) => c.heading)).toEqual(["General", "Monthly"]);
    expect(chunks[1]).toMatchObject({
      applicableTiers: ["basic", "pro"],
      contractTypes: ["monthly"],
      content: "Monthly text.",
      chunkIndex: 1,
      metadata: { fileName: "t.md", policyVersion: "2025-01", documentTitle: "Test Policy", category: "refund" },
    });
    expect(chunks[1]!.embedText).toContain("Monthly");
  });

  it("defaults to all tiers and both contract types, and expands 'all'", () => {
    const [a, b] = chunker.chunk(doc("# A\ntext\n\n# B\n<!-- tiers: all; contracts: all -->\ntext"));
    for (const c of [a!, b!]) {
      expect(c.applicableTiers).toEqual(["free", "basic", "pro", "enterprise"]);
      expect(c.contractTypes).toEqual(["monthly", "annual"]);
    }
  });

  it("rejects unknown tiers instead of silently widening applicability", () => {
    expect(() => chunker.chunk(doc("# A\n<!-- tiers: platinum -->\ntext"))).toThrow(ChunkingError);
  });

  it("splits sections over the token budget on paragraph boundaries with overlap", () => {
    const para = (n: number) => `Paragraph ${n}. ` + "word ".repeat(120);
    const text = [1, 2, 3, 4, 5].map(para).join("\n\n");
    const parts = splitLongText(text, { maxTokens: 300, overlapTokens: 200 });
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(estimateTokens(p)).toBeLessThanOrEqual(300 + 200);
    // overlap: the start of part 2 repeats the end of part 1
    const lastOfFirst = parts[0]!.split("\n\n").at(-1)!;
    expect(parts[1]!.startsWith(lastOfFirst)).toBe(true);
  });

  it("keeps heading and metadata on every part of a split section", () => {
    const body = "# Long\n" + Array.from({ length: 8 }, (_, i) => `Para ${i} ` + "lorem ".repeat(110)).join("\n\n");
    const chunks = chunker.chunk(doc(body), { maxTokens: 300, overlapTokens: 60 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(new Set(chunks.map((c) => c.heading))).toEqual(new Set(["Long"]));
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
    expect(chunks[1]!.metadata).toMatchObject({ part: 2, parts: chunks.length });
  });
});
