import { describe, expect, it } from "vitest";
import { ragSearchRequestSchema } from "./rag.js";

describe("ragSearchRequestSchema", () => {
  it("defaults topK to 5 and trims the query", () => {
    const r = ragSearchRequestSchema.parse({ query: "  refund?  " });
    expect(r).toEqual({ query: "refund?", topK: 5 });
  });
  it("rejects unknown tiers and oversized topK", () => {
    expect(ragSearchRequestSchema.safeParse({ query: "x", tier: "gold" }).success).toBe(false);
    expect(ragSearchRequestSchema.safeParse({ query: "x", topK: 50 }).success).toBe(false);
  });
});
