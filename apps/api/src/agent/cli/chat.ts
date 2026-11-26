import "reflect-metadata";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../app.module.js";
import { AgentService } from "../agent.service.js";
import { AgentEventsService } from "../events/agent-events.service.js";
import { LLM_PROVIDER, type LlmProvider } from "../providers/llm-provider.interface.js";

/**
 * Talk to the real agent from the terminal (needs OPENAI_API_KEY).
 *   pnpm --filter api agent:chat
 * Demo customers: sarah@example.com 482910 (Pro monthly), alex.morgan@example.com 401923 (Basic),
 * james.miller@example.com 730156 (Pro annual), emma.davis@example.com 915284 (Enterprise). Run `pnpm db:seed` first.
 * Commands: /voice and /chat switch the interface mode mid-conversation, /cancel cancels, /quit exits.
 */
const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
const llm = app.get<LlmProvider>(LLM_PROVIDER);
if (!llm.configured) {
  console.error("No language model configured. Set OPENAI_API_KEY in .env, or run `pnpm --filter api agent:demo` for a scripted demonstration.");
  await app.close();
  process.exit(2);
}
const agent = app.get(AgentService);
const { sessionId } = await agent.createSession();
let mode: "chat" | "voice" = "chat";
let lastRunId: string | undefined;

const SHOWN = new Set(["tool.started", "tool.failed", "retrieval.completed", "guardrail.failed", "confirmation.required", "escalation.created", "run.paused"]);
app.get(AgentEventsService).ofSession(sessionId).subscribe((e) => {
  if (!SHOWN.has(e.type)) return;
  const d = e.data as Record<string, unknown>;
  const detail = e.type.startsWith("tool.") ? `${d.tool}${d.errorCode ? ` (${d.errorCode})` : ""}` : e.type === "guardrail.failed" ? `${d.guardrail}: ${d.reason}` : e.type === "retrieval.completed" ? `${(d.sources as unknown[]).length} sources, best ${d.confidenceScore}` : "";
  console.log(`  · ${e.type}${detail ? ` ${detail}` : ""}`);
});

console.log(`model: ${llm.model} | session ${sessionId}\nType a message. /voice /chat /cancel /quit\n`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const line = (await rl.question(`you (${mode})> `)).trim();
  if (!line) continue;
  if (line === "/quit") break;
  if (line === "/voice" || line === "/chat") { mode = line.slice(1) as typeof mode; console.log(`switched to ${mode}`); continue; }
  if (line === "/cancel") {
    if (lastRunId) console.log(JSON.stringify(await agent.cancelRun(lastRunId).catch((e: Error) => e.message)));
    continue;
  }
  try {
    const r = await agent.submitMessage(sessionId, { message: line, clientMessageId: randomUUID(), mode });
    lastRunId = r.runId;
    console.log(`\nagent [${r.status}]: ${r.response}`);
    if (r.sources.length) console.log(`  sources: ${r.sources.map((s) => `${s.document} / ${s.heading}`).join("; ")}`);
    console.log(`  (${r.metrics.llmCalls} model calls, ${r.metrics.toolCalls} tool calls, ${r.metrics.durationMs} ms, ~$${r.metrics.estimatedCostUsd.toFixed(4)})\n`);
  } catch (err) {
    console.log(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
rl.close();
await app.close();
process.exit(0);
