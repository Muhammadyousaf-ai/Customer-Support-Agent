import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../app.module.js";
import { pool } from "../../database/pool.js";
import { seedDatabase } from "../../database/seed-data.js";
import { AgentService } from "../agent.service.js";
import { AgentEventsService } from "../events/agent-events.service.js";
import { LLM_PROVIDER, type LlmRequest } from "../providers/llm-provider.interface.js";
import { callTool, respond, ScriptedLlmProvider, type ScriptedResponder } from "../providers/scripted-llm.provider.js";

/**
 * Scripted demonstration of the orchestration: the real graph, real tools, real database and checkpoints, but a
 * SCRIPTED stand-in for the model, so it runs without an API key. It shows the lifecycle events, the confirmation
 * pause and the guardrails working. It says nothing about how well a real model decides; use `agent:eval` for that.
 *   pnpm --filter api agent:demo
 */
const code = (req: LlmRequest) => /\[CODE-\d+\]/.exec(req.messages.map((m) => m.content).join("\n"))?.[0] ?? "";
const sourceId = (req: LlmRequest) => {
  for (const m of req.messages.filter((x) => x.role === "tool")) {
    const id = (JSON.parse(m.content) as { data?: { sources?: Array<{ chunkId?: string }> } }).data?.sources?.[0]?.chunkId;
    if (id) return id;
  }
  return "";
};
const refundId = (req: LlmRequest) => req.messages.map((m) => /REF-\d+/.exec(m.content)?.[0]).find(Boolean) ?? "";

const script: ScriptedResponder[] = [
  (req) => callTool("verify_identity", { email: "sarah@example.com", verificationCode: code(req) }),
  () => callTool("get_subscription", {}),
  () => callTool("get_payment_history", {}),
  () => callTool("search_knowledge_base", { query: "refund policy for a recent monthly payment" }),
  () => callTool("issue_refund", { paymentId: "PAY-002" }),
  (req) => respond(`Your refund ${refundId(req)} of $49 has been processed. Monthly subscriptions can be refunded within seven days.`, [sourceId(req)]),
];

await seedDatabase(pool);
const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LLM_PROVIDER).useValue(new ScriptedLlmProvider(script)).compile();
await moduleRef.init();
const agent = moduleRef.get(AgentService);
const { sessionId } = await agent.createSession();

const t0 = Date.now();
moduleRef.get(AgentEventsService).ofSession(sessionId).subscribe((e) => {
  if (e.type === "response.delta") return;
  const d = e.data as Record<string, unknown>;
  const detail = d.tool ?? d.decision ?? d.guardrail ?? d.summary ?? d.status ?? "";
  console.log(`${String(Date.now() - t0).padStart(6)} ms  ${e.type.padEnd(24)} ${detail ? `${detail}${d.toolName ? ` ${d.toolName}` : ""}` : ""}`);
});

console.log("SCRIPTED model (orchestration demo, not a model-quality test)\n");
const say = async (message: string, id: string) => {
  console.log(`\ncustomer: ${message}\n`);
  const r = await agent.submitMessage(sessionId, { message, clientMessageId: id, mode: "chat" });
  console.log(`\nagent [${r.status}]: ${r.response}`);
  if (r.pendingAction) console.log(`  pending action ${r.pendingAction.id}: ${r.pendingAction.summary}`);
  return r;
};
await say("I was charged yesterday but I barely use the app. Can I get my money back? I'm sarah@example.com, my code is 482910", "demo-1");
const { rows: before } = await pool.query("select count(*)::int as n from refunds");
console.log(`  refunds in the database before the customer confirms: ${before[0].n}`);
const done = await say("yes", "demo-2");
const { rows: after } = await pool.query("select id, amount_cents from refunds");
console.log(`\nrefunds after confirmation: ${after.map((r) => `${r.id} $${r.amount_cents / 100}`).join(", ")}`);
console.log(`metrics: ${JSON.stringify(done.metrics)}`);
await moduleRef.close();
await pool.end();
