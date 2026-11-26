import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "./health.js";

describe("healthResponseSchema", () => {
  it("accepts a healthy response", () => {
    expect(healthResponseSchema.safeParse({ status: "ok", db: "up" }).success).toBe(true);
  });
  it("rejects unknown status", () => {
    expect(healthResponseSchema.safeParse({ status: "great", db: "up" }).success).toBe(false);
  });
});
