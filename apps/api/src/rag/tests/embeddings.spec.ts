import { describe, expect, it } from "vitest";
import { LocalHashEmbedder } from "../embeddings/local-hash.embedder.js";

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const e = new LocalHashEmbedder();

describe("LocalHashEmbedder", () => {
  it("returns 1536-dim unit vectors, deterministically", () => {
    const v = e.embedOne("refund policy for monthly plans");
    expect(v).toHaveLength(1536);
    expect(Math.sqrt(dot(v, v))).toBeCloseTo(1, 6);
    expect(e.embedOne("refund policy for monthly plans")).toEqual(v);
  });
  it("scores paraphrases above unrelated text", () => {
    const q = e.embedOne("I want my money back");
    expect(dot(q, e.embedOne("Refunds are returned to the original payment method"))).toBeGreaterThan(
      dot(q, e.embedOne("Webhooks are retried six times over 24 hours")),
    );
  });
  it("handles empty input without NaN", () => {
    expect(e.embedOne("   ").every(Number.isFinite)).toBe(true);
  });
});
