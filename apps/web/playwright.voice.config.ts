import { defineConfig, devices } from "@playwright/test";
import { afterSpeech, bargeIn } from "./e2e/fixtures/make-wav";

/**
 * Voice E2E: real Chrome with a FAKE microphone (a WAV file played once) -> real Next app -> real NestJS voice gateway ->
 * real PostgreSQL. The speech model is the scripted provider (VOICE_PROVIDER=fake): it detects speech from the microphone
 * energy, "hears" scripted utterances, and calls the real support agent. What this proves: capture, worklet, resampling, the
 * WebSocket protocol, playback, interruption, delegation and persistence. What it does NOT prove: OpenAI Realtime's behaviour, echo
 * cancellation or noise handling with a real microphone and room (that needs the manual checklist in docs/voice.md).
 * Runs on separate ports (3100/4100) so it never touches a dev server on 3000/4000.
 */
// E2E specs reseed their database, so they use support_ai_test (created and migrated by `pnpm --filter api test:db`), never the dev one.
const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://support:support@localhost:5433/support_ai_test";
process.env.DATABASE_URL = TEST_DB; // inherited by the specs' own `db:seed` calls
const webPort = 3100;
const apiPort = 4100;
const chromeArgs = (wav: string) => ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}%noloop`, "--autoplay-policy=no-user-gesture-required"];
const base = { ...devices["Desktop Chrome"], channel: process.env.PW_CHANNEL ?? "chrome", permissions: ["microphone"], baseURL: `http://localhost:${webPort}` };

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  projects: [
    // Phase 7: the observability drawer against real runs (no microphone needed).
    // Phase 9: accounts, roles, tickets, handover and knowledge-base management.
    { name: "accounts", testMatch: /accounts\.spec\.ts/, use: { ...devices["Desktop Chrome"], channel: process.env.PW_CHANNEL ?? "chrome", baseURL: `http://localhost:${webPort}` } },
    { name: "observability", testMatch: /observability\.spec\.ts/, use: { ...devices["Desktop Chrome"], channel: process.env.PW_CHANNEL ?? "chrome", baseURL: `http://localhost:${webPort}` } },
    // The Phase 5 chat suite against this same stack, to prove adding voice did not break chat.
    { name: "chat-regression", testMatch: /chat\.spec\.ts/, use: { ...devices["Desktop Chrome"], channel: process.env.PW_CHANNEL ?? "chrome", baseURL: `http://localhost:${webPort}` } },
    { name: "voice-after-speech", testMatch: /voice-flow\.spec\.ts/, use: { ...base, launchOptions: { args: chromeArgs(afterSpeech()) } } },
    { name: "voice-barge-in", testMatch: /voice-barge-in\.spec\.ts/, use: { ...base, launchOptions: { args: chromeArgs(bargeIn()) } } },
  ],
  webServer: [
    {
      command: "pnpm --filter api test:db && pnpm --filter api db:seed && pnpm --filter api build && node ../api/dist/main.js",
      cwd: ".",
      url: `http://localhost:${apiPort}/v1/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        DATABASE_URL: TEST_DB, AGENT_LLM: "e2e", E2E_LLM_DELAY_MS: "250", EMBEDDINGS_PROVIDER: "local", OPENAI_API_KEY: "", PORT: String(apiPort), WEB_ORIGIN: `http://localhost:${webPort}`,
        AUTH_RATE_LIMIT_PER_MIN: "1000", REQUIRE_EMAIL_VERIFICATION: "false", SSE_HEARTBEAT_MS: "2000", RATE_LIMIT_SESSION_PER_MIN: "200", RATE_LIMIT_IP_PER_MIN: "2000",
        VOICE_PROVIDER: "fake", VOICE_FAKE_UTTERANCES: "Can you refund my last payment?|Yes", VOICE_FAKE_FRAME_MS: "200",
      },
    },
    { command: `pnpm exec next dev -p ${webPort}`, url: `http://localhost:${webPort}/support`, reuseExistingServer: false, timeout: 180_000, env: { NEXT_PUBLIC_API_URL: `http://localhost:${apiPort}/v1`, NEXT_DIST_DIR: ".next-voice" } },
  ],
});
