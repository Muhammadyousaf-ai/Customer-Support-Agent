import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

describe("loadEnv", () => {
  it("applies defaults", () => {
    expect(loadEnv({}).PORT).toBe(4000);
  });
  it("rejects an invalid web origin", () => {
    expect(() => loadEnv({ WEB_ORIGIN: "nope" })).toThrow(/Invalid environment/);
  });
});

describe("production configuration guard", () => {
  const prod = { NODE_ENV: "production", DATABASE_URL: "postgres://app:s3cret@db.example.com:5432/app", WEB_ORIGIN: "https://app.example.com", ADMIN_API_KEY: "0123456789abcdefghij", OPENAI_API_KEY: "key", JWT_SECRET: "a-long-random-production-secret-0123456789" };
  it("accepts a safe production configuration", () => {
    expect(loadEnv(prod).NODE_ENV).toBe("production");
  });
  it.each([
    ["no admin key", { ADMIN_API_KEY: "" }, /ADMIN_API_KEY/],
    ["short admin key", { ADMIN_API_KEY: "short" }, /ADMIN_API_KEY/],
    ["localhost origin", { WEB_ORIGIN: "http://localhost:3000" }, /WEB_ORIGIN/],
    ["dev database credentials", { DATABASE_URL: "postgres://support:support@db:5432/x" }, /DATABASE_URL/],
    ["no OpenAI key", { OPENAI_API_KEY: "" }, /OPENAI_API_KEY/],
    ["default JWT secret", { JWT_SECRET: "dev-only-jwt-secret-change-me-0123456789abcdef" }, /JWT_SECRET/],
    ["short JWT secret", { JWT_SECRET: "short" }, /JWT_SECRET/],
    ["test double model", { AGENT_LLM: "e2e" }, /test double/],
    ["fake voice provider", { VOICE_PROVIDER: "fake" }, /VOICE_PROVIDER/],
  ])("refuses to start with %s, naming the variable but never its value", (_n, over, re) => {
    let message = "";
    try { loadEnv({ ...prod, ...over } as never); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(re);
    expect(message).not.toContain("s3cret");
    expect(message).not.toContain("0123456789abcdefghij");
  });
  it("is not enforced outside production", () => {
    expect(() => loadEnv({ NODE_ENV: "development" } as never)).not.toThrow();
  });
});
