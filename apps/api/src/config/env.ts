import { config } from "dotenv";
import { z } from "zod";

// pnpm --filter runs in apps/api, but .env lives at the repo root. A local apps/api/.env still wins.
// Tests stay hermetic: they never load the real keys.
if (!process.env.VITEST) config({ path: [".env", new URL("../../../../.env", import.meta.url).pathname], quiet: true });

/** Empty strings in .env mean "unset". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.url().default("http://localhost:3000"),
  DATABASE_URL: z.string().default("postgres://support:support@localhost:5433/support_ai"),
  /** Text agent, embeddings and Realtime voice all use OpenAI. */
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.url().default("https://api.openai.com/v1"),
  OPENAI_CHAT_MODEL: z.string().default("gpt-4.1-mini"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  MAX_AUTO_REFUND_USD: z.coerce.number().default(100),
  // Agent execution budgets (starting values, configurable)
  AGENT_MAX_ITERATIONS: z.coerce.number().int().positive().default(12),
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().positive().default(15),
  AGENT_MAX_EVIDENCE_RETRIES: z.coerce.number().int().min(0).default(1),
  AGENT_MAX_RETRIEVAL_REFINEMENTS: z.coerce.number().int().min(0).default(1),
  AGENT_DEADLINE_MS: z.coerce.number().int().positive().default(60_000),
  AGENT_CONFIRMATION_TTL_MS: z.coerce.number().int().positive().default(15 * 60_000),
  AGENT_HISTORY_WINDOW: z.coerce.number().int().positive().default(20),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  /** Estimated USD per million tokens. Configure from your provider's current price list; defaults are placeholders. */
  LLM_PRICE_INPUT_PER_M: z.coerce.number().min(0).default(0.15),
  LLM_PRICE_OUTPUT_PER_M: z.coerce.number().min(0).default(0.6),
  AGENT_LLM_EVIDENCE_CHECK: z.enum(["true", "false"]).default("true"),
  /** Persist sanitized prompt text in traces (off by default: traces may otherwise hold customer data). */
  TRACE_PROMPTS: z.enum(["true", "false"]).default("false"),
  SIMULATE_FAILURE: z.enum(["none", "tool", "llm_timeout", "retrieval", "voice_disconnect"]).default("none"),

  /** `e2e` swaps in a rule-based dev model for browser tests. Refused in production. */
  AGENT_LLM: optional(z.enum(["e2e"])),
  E2E_LLM_DELAY_MS: z.coerce.number().int().min(0).default(250),

  // Streaming and abuse limits
  SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(15_000),
  SSE_MAX_CONNECTIONS_PER_SESSION: z.coerce.number().int().positive().default(4),
  RATE_LIMIT_SESSION_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_IP_PER_MIN: z.coerce.number().int().positive().default(60),

  // Tools
  SIMULATE_TOOL_FAILURE: optional(z.string()),
  TOOL_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(100),

  // RAG
  EMBEDDINGS_PROVIDER: optional(z.enum(["openai", "local"])),
  RAG_VERIFIER: optional(z.enum(["llm", "heuristic"])),
  RETRIEVAL_MIN_SIMILARITY: optional(z.coerce.number().min(0).max(1)),
  KNOWLEDGE_BASE_DIR: z.string().default("../../knowledge-base"),
  ADMIN_API_KEY: z.string().default(""),

  // Accounts and RBAC (Phase 9)
  /** HS256 signing secret for access tokens. Required (32+ chars) in production; the development default is refused there. */
  JWT_SECRET: z.string().default("dev-only-jwt-secret-change-me-0123456789abcdef"),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().positive().default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().positive().default(30),
  /** Email verification is enforced by default in production and optional in development (no mail provider is wired up). */
  REQUIRE_EMAIL_VERIFICATION: optional(z.enum(["true", "false"])),
  /** Anonymous demo conversations (bearer conversation token, no account). Keep on for the public demo. */
  ALLOW_ANONYMOUS_SESSIONS: z.enum(["true", "false"]).default("false"), // the AI assistant requires an account; "true" is a test/demo escape hatch
  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().positive().default(15),
  AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
  KB_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(1_000_000),

  // Production protection (Phase 8)
  /** Application-level daily AI spend cap in USD (0 disables it). Approximate: a protective limit, not a provider billing cap. */
  DAILY_AI_BUDGET_USD: z.coerce.number().min(0).default(5),
  /** Budget held for a run/voice session while it is in flight, reconciled against recorded usage afterwards. */
  BUDGET_RUN_RESERVE_USD: z.coerce.number().min(0).default(0.01),
  BUDGET_VOICE_RESERVE_USD: z.coerce.number().min(0).default(0.1),
  /** Cost charged against the budget for a model call whose price is unknown (so an unpriced model can still not run unbounded). */
  BUDGET_UNPRICED_CALL_USD: z.coerce.number().min(0).default(0.002),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(20_000),
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(32_768),
  APP_VERSION: z.string().default("1.0.0"),

  // Observability (Phase 7)
  TELEMETRY_ENABLED: z.enum(["true", "false"]).default("true"),
  /** Diagnostic traces (spans, model invocations, errors) older than this are deleted. Business audit records are not touched. */
  TELEMETRY_RETENTION_DAYS: z.coerce.number().positive().default(30),
  TELEMETRY_QUEUE_MAX: z.coerce.number().int().positive().default(5000),
  TELEMETRY_FLUSH_MS: z.coerce.number().int().positive().default(200),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  // Voice. `fake` runs a scripted in-process provider for browser tests and demos without a key. Refused in production.
  VOICE_PROVIDER: optional(z.enum(["openai", "fake"])),
  /** OpenAI Realtime voice. Uses OPENAI_API_KEY. */
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime-mini"),
  OPENAI_REALTIME_VOICE: z.string().default("marin"),
  OPENAI_TRANSCRIBE_MODEL: z.string().default("gpt-4o-mini-transcribe"),
  /** Tuning knob: raise to medium/high if turns feel slow to end, keep low if customers get cut off mid-sentence. */
  OPENAI_VAD_EAGERNESS: z.enum(["low", "medium", "high", "auto"]).default("low"),
  /** Pipe-separated scripted utterances for VOICE_PROVIDER=fake. */
  VOICE_FAKE_UTTERANCES: optional(z.string()),
  VOICE_FAKE_FRAME_MS: z.coerce.number().int().positive().default(20),
  VOICE_MAX_SESSION_MINUTES: z.coerce.number().positive().default(10),
  VOICE_MAX_RECONNECT_ATTEMPTS: z.coerce.number().int().min(0).default(3),
  VOICE_INPUT_SAMPLE_RATE: z.coerce.number().int().positive().default(16_000),
  VOICE_OUTPUT_SAMPLE_RATE: z.coerce.number().int().positive().default(24_000),
  VOICE_CHUNK_DURATION_MS: z.coerce.number().int().positive().default(40),
  VOICE_TICKET_TTL_MS: z.coerce.number().int().positive().default(30_000),
  VOICE_PROVIDER_SETUP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  VOICE_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  VOICE_RECONNECT_BASE_DELAY_MS: z.coerce.number().int().min(0).default(1_000),
  VOICE_RECONNECT_MAX_DELAY_MS: z.coerce.number().int().min(0).default(8_000),
  /** Per-session microphone budget. 16 kHz PCM16 mono is 32,000 B/s; the default allows 2x real time. */
  VOICE_MAX_INPUT_BYTES_PER_SEC: z.coerce.number().int().positive().default(64_000),
  VOICE_MAX_BUFFERED_BYTES: z.coerce.number().int().positive().default(256_000),
  VOICE_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) throw new Error(`Invalid environment: ${z.prettifyError(result.error)}`);
  assertProductionConfig(result.data);
  return result.data;
}

/** Refuses to boot a production process that would be unsafe. Messages name the variable, never print its value. */
export function assertProductionConfig(env: Env): void {
  if (env.NODE_ENV !== "production") return;
  const problems: string[] = [];
  if (!env.ADMIN_API_KEY || env.ADMIN_API_KEY.length < 16) problems.push("ADMIN_API_KEY must be set (16+ characters): prompt traces and admin endpoints are otherwise closed or weak");
  if (/localhost|127\.0\.0\.1/.test(env.WEB_ORIGIN)) problems.push("WEB_ORIGIN must be the public frontend origin, not localhost");
  if (env.WEB_ORIGIN.split(",").some((o) => o.trim() === "*")) problems.push("WEB_ORIGIN must not be a wildcard");
  if (!/^postgres(ql)?:\/\//.test(env.DATABASE_URL) || /support:support@/.test(env.DATABASE_URL)) problems.push("DATABASE_URL must point at the production database (the local development credentials are not allowed)");
  if (env.JWT_SECRET.length < 32 || env.JWT_SECRET.startsWith("dev-only")) problems.push("JWT_SECRET must be set to a random value of 32+ characters");
  if (env.AGENT_LLM === "e2e") problems.push("AGENT_LLM=e2e is a test double");
  if (env.VOICE_PROVIDER === "fake") problems.push("VOICE_PROVIDER=fake is a test double");
  if (!env.OPENAI_API_KEY && env.AGENT_LLM !== "e2e") problems.push("OPENAI_API_KEY is required");
  if (problems.length) throw new Error(`Refusing to start in production:\n - ${problems.join("\n - ")}`);
}
