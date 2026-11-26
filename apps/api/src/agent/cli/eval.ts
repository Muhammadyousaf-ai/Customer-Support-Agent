import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../app.module.js";
import { pool } from "../../database/pool.js";
import { seedDatabase } from "../../database/seed-data.js";
import { FailureSimulator, type SimulationMode } from "../../tools/simulation/failure-simulator.service.js";
import { AgentService } from "../agent.service.js";
import { formatReport, runEvaluation, type EvalSuite } from "../evaluation/runner.js";
import { LLM_PROVIDER, type LlmProvider } from "../providers/llm-provider.interface.js";

/**
 * Evaluates REAL model decision quality against evaluations/agent-cases.json. Needs OPENAI_API_KEY.
 *   pnpm --filter api agent:eval                 run everything
 *   pnpm --filter api agent:eval -- --only=refund-indirect-barely-use,general-1
 *   pnpm --filter api agent:eval -- --dry-run    validate the scenario file only
 * Results depend on the model and vary between runs; treat them as measurements, not guarantees.
 */
const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const suite = JSON.parse(readFileSync(resolve(process.cwd(), "../../evaluations/agent-cases.json"), "utf8")) as EvalSuite;

if (args.includes("--dry-run")) {
  const missing = suite.cases.flatMap((c) => c.turns.flatMap((t) => [...t.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!)).filter((k) => !suite.logins[k]));
  console.log(`${suite.cases.length} scenarios, ${suite.cases.filter((c) => c.supported).length} supported, ${suite.cases.filter((c) => c.unsupported).length} unsupported; unknown login placeholders: ${missing.length || "none"}`);
  process.exit(missing.length ? 1 : 0);
}

const boot = async () => NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
let app = await boot();
const llm = app.get<LlmProvider>(LLM_PROVIDER);
if (!llm.configured) {
  console.error("No language model configured. Set OPENAI_API_KEY to evaluate real decision quality (use --dry-run to validate the scenarios).");
  await app.close();
  process.exit(2);
}
console.log(`model: ${llm.model}; scenarios: ${only?.length ?? suite.cases.length}\n`);

const { results, metrics } = await runEvaluation(
  suite,
  {
    get agent() {
      return app.get(AgentService); // always the current instance, even after a simulated restart
    },
    pool,
    reset: () => seedDatabase(pool),
    restart: async () => {
      await app.close();
      app = await boot();
      return app.get(AgentService);
    },
    armFailure: (tool, mode, times) => app.get(FailureSimulator).arm(tool, mode as SimulationMode, times),
    clearFailures: () => app.get(FailureSimulator).clear(),
  },
  { only },
);
console.log(formatReport(results, metrics, suite.targets));
await app.close();
await pool.end();
process.exit(results.every((r) => r.passed) ? 0 : 1);
