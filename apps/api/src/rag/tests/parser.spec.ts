import { describe, expect, it } from "vitest";
import { DocumentParseError, parseDocument } from "../ingestion/document-parser.js";

const good = `---\ntitle: Refund Policy\ncategory: refund\nversion: "2025-01"\n---\n# H\nbody`;

describe("parseDocument", () => {
  it("parses frontmatter and computes a stable checksum", () => {
    const a = parseDocument("r.md", good);
    expect(a).toMatchObject({ title: "Refund Policy", category: "refund", version: "2025-01", body: "# H\nbody" });
    expect(parseDocument("r.md", good).checksum).toBe(a.checksum);
    expect(parseDocument("r.md", good + "x").checksum).not.toBe(a.checksum);
  });
  it("rejects missing frontmatter, bad category and empty bodies", () => {
    expect(() => parseDocument("r.md", "# no frontmatter")).toThrow(DocumentParseError);
    expect(() => parseDocument("r.md", good.replace("refund\n", "weather\n"))).toThrow(/category/);
    expect(() => parseDocument("r.md", "---\ntitle: T\ncategory: refund\nversion: 1\n---\n  ")).toThrow(/empty/);
  });
});
