import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../app.module.js";
import { pool } from "../../database/pool.js";
import { seedDatabase } from "../../database/seed-data.js";
import { SessionsService } from "../../sessions/sessions.service.js";
import { ToolEventsService } from "../events/tool-events.service.js";
import { ToolExecutor } from "../registry/tool-executor.service.js";
import { FailureSimulator, SIMULATION_MODES, type SimulationMode } from "../simulation/failure-simulator.service.js";

/**
 * Deterministic Phase 3 test runner. It plays the role the LLM will play in Phase 4: choosing the tool
 * sequence. The backend still enforces every rule, so the outcome is the same whoever chooses the sequence.
 *   pnpm --filter api tools:demo -- [scenario] [--simulate=issue_refund:after_commit]
 */
const SCENARIOS: Record<string, { email: string; code: string; paymentId: string; note: string }> = {
  "refund-pro": { email: "sarah@example.com", code: "482910", paymentId: "PAY-002", note: "Pro monthly, $49 paid 2 days ago -> refund completes" },
  "expired-window": { email: "sarah@example.com", code: "482910", paymentId: "PAY-007", note: "Pro monthly, paid 35 days ago -> rejected" },
  annual: { email: "james.miller@example.com", code: "730156", paymentId: "PAY-003", note: "Pro annual -> human approval, ticket created" },
  enterprise: { email: "emma.davis@example.com", code: "915284", paymentId: "PAY-004", note: "Enterprise -> human approval, ticket created" },
  suspended: { email: "olivia.smith@example.com", code: "557392", paymentId: "PAY-006", note: "Suspended account -> human approval, ticket created" },
};

const args = process.argv.slice(2).filter((a) => a !== "--");
const scenarioName = args.find((a) => !a.startsWith("--")) ?? "refund-pro";
const simulate = args.find((a) => a.startsWith("--simulate="))?.slice("--simulate=".length);
const scenario = SCENARIOS[scenarioName];
if (!scenario) {
  console.error(`Unknown scenario "${scenarioName}". Choose: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(2);
}

await seedDatabase(pool);
const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
const executor = app.get(ToolExecutor);
const sessions = app.get(SessionsService);
const events = app.get(ToolEventsService);

const session = await sessions.create();
const runId = await sessions.startRun(session.id);
if (simulate) {
  const [tool, mode, times] = simulate.split(":");
  if (!tool || !SIMULATION_MODES.includes(mode as SimulationMode)) {
    console.error(`--simulate=<tool>:<${SIMULATION_MODES.join("|")}>[:times]`);
    process.exit(2);
  }
  app.get(FailureSimulator).arm(tool, mode as SimulationMode, Number(times) || 1);
}

console.log(`Scenario: ${scenarioName} - ${scenario.note}${simulate ? `  [simulating ${simulate}]` : ""}\n`);
events.ofRun(runId).subscribe((e) => {
  if (e.type !== "tool.started" || e.data.attempt === 1) return;
  console.log(`    ... retry attempt ${e.data.attempt} of ${e.data.tool}`);
});

let n = 0;
const call = async (tool: string, input: unknown) => {
  const r = await executor.execute({ tool, input, sessionId: session.id, runId, toolCallId: `call_${++n}` });
  const detail = r.success ? JSON.stringify(r.data) : `${r.error!.code}: ${r.error!.message}`;
  const shown = detail.length > 150 ? `${detail.slice(0, 147)}...` : detail;
  console.log(`${r.success ? "OK  " : "FAIL"} ${tool.padEnd(26)} ${String(r.metadata.durationMs).padStart(4)}ms x${r.metadata.attempts}  ${shown}`);
  return r;
};

await call("verify_identity", { email: scenario.email, verificationCode: scenario.code });
await call("get_subscription", {});
await call("get_contract", {});
await call("get_payment_history", {});
await call("search_knowledge_base", { query: "What is the refund policy for my subscription?" });
const check = await call("check_refund_eligibility", { paymentId: scenario.paymentId });
const decision = (check.data as { decision?: string } | undefined)?.decision;
if (decision === "eligible") {
  await call("issue_refund", { paymentId: scenario.paymentId });
} else if (decision) {
  await call("create_escalation_ticket", {
    reason: decision === "manual_approval_required" ? "MANUAL_APPROVAL_REQUIRED" : decision === "escalate" ? "POLICY_NOT_FOUND" : "OTHER",
    category: "refund",
    summary: `Refund requested for ${scenario.paymentId}; automated decision: ${decision}.`,
    ...(decision === "rejected" ? { priority: "low" } : {}),
  });
}

const { rows } = await pool.query("select tool, status, attempts from tool_executions where run_id = $1 order by created_at", [runId]);
const { rows: refunds } = await pool.query("select id, payment_id, amount_cents from refunds");
const ok = rows.filter((r) => r.status === "success").length;
const refundNote = refunds[0] ? ` (${refunds[0].id}, ${refunds[0].payment_id}, $${refunds[0].amount_cents / 100})` : "";
console.log(`\n${ok}/${rows.length} tool executions succeeded; ${refunds.length} refund row(s) in the database${refundNote}`);
await app.close();
await pool.end();
