import { loadEnv } from "../../config/env.js";
import { buildHarness, pool } from "../../tools/tests/harness.js";
import { AgentService } from "../agent.service.js";
import { resolveAgentConfig, type AgentConfig } from "../config/agent.config.js";
import { AgentEventsService } from "../events/agent-events.service.js";
import { AgentTraceService } from "../events/agent-trace.service.js";
import { EvidenceChecker } from "../guardrails/evidence-checker.js";
import { SecretVault } from "../guardrails/secret-vault.js";
import { CheckpointerService } from "../memory/checkpointer.service.js";
import { ConversationMemoryService } from "../memory/conversation-memory.service.js";
import { PendingActionsService } from "../memory/pending-actions.service.js";
import { SummarizationService } from "../memory/summarization.service.js";
import type { AgentDeps } from "../nodes/node-deps.js";
import type { LlmProvider, LlmRequest } from "../providers/llm-provider.interface.js";
import { ScriptedLlmProvider, type ScriptedResponder } from "../providers/scripted-llm.provider.js";
import { RunRegistry, RunsService } from "../runs/runs.service.js";

export { pool };

export interface AgentHarnessOptions {
  script?: ScriptedResponder | ScriptedResponder[];
  llm?: LlmProvider;
  cfg?: Partial<AgentConfig>;
  timeoutOverrideMs?: number;
}

/** The full stack (real PostgreSQL, real LangGraph checkpointer, real Phase 2/3 services) with a pluggable model. */
export async function buildAgentHarness(opts: AgentHarnessOptions = {}) {
  const base = buildHarness({ timeoutOverrideMs: opts.timeoutOverrideMs });
  const env = loadEnv({});
  const cfg: AgentConfig = { ...resolveAgentConfig(env), llmEvidenceCheck: false, ...opts.cfg };
  const llm = opts.llm ?? new ScriptedLlmProvider(opts.script ?? []);

  const events = new AgentEventsService(pool, base.events);
  const trace = new AgentTraceService(pool);
  const memory = new ConversationMemoryService(pool);
  const pending = new PendingActionsService(pool);
  const runRegistry = new RunRegistry();
  const runs = new RunsService(pool);
  const vault = new SecretVault();
  const evidence = new EvidenceChecker(llm, cfg);
  const summarizer = new SummarizationService(memory, llm, cfg);
  const checkpointer = new CheckpointerService(env);

  const deps: AgentDeps = {
    cfg, llm, tools: base.executor, registry: base.registry, events, trace, memory, pending, runRegistry, runs, vault, evidence,
    sessions: base.sessions, subscriptions: base.subscriptions, contracts: base.contracts, customers: base.customers, summarizer,
  };
  const agent = new AgentService(deps, checkpointer, pool, base.sessions, runs, runRegistry, memory, pending, events, trace, vault, cfg);
  await agent.init();

  let n = 0;
  /** Starts a session through the real service and returns helpers bound to it. */
  async function session() {
    const created = await agent.createSession();
    const say = (message: string, clientMessageId = `msg-${created.sessionId.slice(-6)}-${++n}`) => agent.submitMessage(created.sessionId, { message, clientMessageId, mode: "chat" });
    return { ...created, say };
  }

  return {
    ...base, agent, llm: llm as ScriptedLlmProvider, deps, events, trace, memory, pending, runs, runRegistry, cfg, session,
    reset: base.reset,
    ingest: () => base.ingestion.ingestDirectory(),
    close: async () => {
      await checkpointer.onModuleDestroy();
    },
  };
}

export type AgentHarness = Awaited<ReturnType<typeof buildAgentHarness>>;

// ---- helpers for writing scripted models ---------------------------------------------------------------------------
export const toolMessages = (req: LlmRequest) => req.messages.filter((m) => m.role === "tool");
export const lastUser = (req: LlmRequest) => [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
/** The placeholder the vault substituted for a verification code in the customer's message. */
export const codePlaceholder = (req: LlmRequest) => /\[CODE-\d+\]/.exec(req.messages.map((m) => m.content).join("\n"))?.[0] ?? "[MISSING-CODE]";
/** First retrieved policy chunk id found in any tool result so far. */
export function firstSourceId(req: LlmRequest): string {
  for (const m of toolMessages(req)) {
    try {
      const id = (JSON.parse(m.content) as { data?: { sources?: Array<{ chunkId?: string }> } }).data?.sources?.[0]?.chunkId;
      if (id) return id;
    } catch { /* not JSON */ }
  }
  return "no-source";
}
export const refundIdFrom = (req: LlmRequest): string => {
  for (const m of toolMessages(req)) {
    const id = /REF-\d+/.exec(m.content)?.[0];
    if (id) return id;
  }
  return "REF-000";
};
export const count = async (table: string, where = "true", params: unknown[] = []): Promise<number> => {
  const { rows } = await pool.query(`select count(*)::int as n from ${table} where ${where}`, params);
  return rows[0].n;
};
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
