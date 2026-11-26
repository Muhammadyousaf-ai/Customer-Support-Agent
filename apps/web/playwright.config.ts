import { defineConfig, devices } from "@playwright/test";

/**
 * Full-stack E2E: real browser -> real Next.js app -> real NestJS API -> real PostgreSQL.
 * The API runs with AGENT_LLM=e2e, a rule-based development stand-in for the model (no API key needed), so these
 * tests exercise the real graph, tools, guardrails, confirmation flow and SSE transport. They say nothing about how a
 * real model decides. Uses the system Chrome (`channel: "chrome"`) because Playwright's bundled Chromium does not
 * support every OS version; set PW_CHANNEL= to use the bundled browser instead.
 */
export default defineConfig({
  testDir: "./e2e",
  workers: 1, // one shared database
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 12_000 },
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure", channel: process.env.PW_CHANNEL ?? "chrome" },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], channel: process.env.PW_CHANNEL ?? "chrome" } }],
  webServer: [
    {
      command: "pnpm --filter api build && node ../api/dist/main.js",
      cwd: ".",
      url: "http://localhost:4000/v1/health",
      reuseExistingServer: true,
      timeout: 120_000,
      env: { AGENT_LLM: "e2e", E2E_LLM_DELAY_MS: "350", EMBEDDINGS_PROVIDER: "local", OPENAI_API_KEY: "", PORT: "4000", WEB_ORIGIN: "http://localhost:3000", SSE_HEARTBEAT_MS: "2000", RATE_LIMIT_SESSION_PER_MIN: "100", RATE_LIMIT_IP_PER_MIN: "1000" },
    },
    { command: "pnpm exec next dev -p 3000", url: "http://localhost:3000/support", reuseExistingServer: true, timeout: 120_000, env: { NEXT_PUBLIC_API_URL: "http://localhost:4000/v1", NEXT_PUBLIC_SSE_IDLE_TIMEOUT_MS: "8000" } },
  ],
});
