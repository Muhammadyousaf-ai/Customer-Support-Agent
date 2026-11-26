import "reflect-metadata";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import type { BillingPeriod, RagSearchResponse, Tier } from "@support-ai/contracts";
import { AppModule } from "../../app.module.js";
import { RagService } from "../rag.service.js";

interface Case {
  id: string;
  query: string;
  tier?: Tier;
  contractType?: BillingPeriod;
  inScope: boolean;
  expectDocument?: string;
  expectHeading?: string;
}

const casesPath = resolve(process.cwd(), "../../evaluations/retrieval-cases.json");
const cases = JSON.parse(readFileSync(casesPath, "utf8")) as Case[];
const sweep = process.argv.includes("--sweep");

const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
const rag = app.get(RagService);

const rows: Array<{ c: Case; res: RagSearchResponse; pass: boolean; note: string }> = [];
for (const c of cases) {
  const res = await rag.search({ query: c.query, tier: c.tier, contractType: c.contractType, topK: 5 });
  let pass: boolean;
  let note = "";
  if (c.inScope) {
    const top = res.sources[0];
    pass = res.status === "grounded" && top?.document === c.expectDocument && top?.heading === c.expectHeading;
    note = pass ? "" : `got ${res.status}${top ? ` ${top.document} / ${top.heading}` : ""}${res.verification && !res.verification.supported ? ` [verifier: ${res.verification.reason}]` : ""}`;
  } else {
    pass = res.requiresEscalation;
    note = pass ? "" : `answered from ${res.sources[0]?.heading}`;
  }
  rows.push({ c, res, pass, note });
}

for (const { c, res, pass, note } of rows) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${c.inScope ? "in " : "out"}  top=${res.confidenceScore.toFixed(2)}  ${res.status.padEnd(21)} ${c.id}  ${note}`);
}
const inScope = rows.filter((r) => r.c.inScope);
const outScope = rows.filter((r) => !r.c.inScope);
const latencies = rows.map((r) => r.res.metrics.totalLatencyMs).sort((a, b) => a - b);
console.log(
  `\nprovider=${rows[0]!.res.providers.embeddings} model=${rows[0]!.res.providers.embeddingModel} threshold=${rows[0]!.res.threshold}`,
);
console.log(`in-scope answered correctly: ${inScope.filter((r) => r.pass).length}/${inScope.length}`);
console.log(`out-of-scope escalated:      ${outScope.filter((r) => r.pass).length}/${outScope.length}`);
console.log(`latency p50=${latencies[Math.floor(latencies.length / 2)]}ms max=${latencies.at(-1)}ms`);

if (sweep) {
  console.log("\nsimilarity-gate sweep (verifier ignored): threshold -> in-scope kept / out-of-scope wrongly kept");
  for (let t = 0.1; t <= 0.7001; t += 0.05) {
    const kept = inScope.filter((r) => r.res.confidenceScore >= t).length;
    const wrong = outScope.filter((r) => r.res.confidenceScore >= t).length;
    console.log(`  ${t.toFixed(2)} -> ${kept}/${inScope.length} kept, ${wrong}/${outScope.length} false accepts`);
  }
}
await app.close();
process.exit(rows.every((r) => r.pass) ? 0 : 1);
