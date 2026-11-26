import type { AgentRunResponse, AgentRunStatus } from "@support-ai/contracts";
import type pg from "pg";

/** One evaluation scenario. See evaluations/agent-cases.json. */
export interface EvalCase {
  id: string;
  category: string;
  turns: string[];
  expect: {
    status?: AgentRunStatus;
    statusOneOf?: AgentRunStatus[];
    /** Tools the MODEL chose (executed or blocked by the backend). */
    toolsCalled?: string[];
    toolsNotCalled?: string[];
    refunds?: number;
    tickets?: number;
    sourcesAtLeast?: number;
    responseMustMatch?: string[];
    responseMustNotMatch?: string[];
    db?: Array<{ sql: string; equals: unknown }>;
  };
  supported?: boolean;
  unsupported?: boolean;
  restoration?: boolean;
  restartBeforeTurn?: number;
  simulate?: string[];
}

export interface EvalSuite {
  logins: Record<string, string>;
  targets: Record<string, number>;
  cases: EvalCase[];
}

export interface EvalAgent {
  createSession(): Promise<{ sessionId: string }>;
  submitMessage(sessionId: string, input: { message: string; clientMessageId: string; mode?: "chat" | "voice" }): Promise<AgentRunResponse>;
}

export interface EvalEnv {
  agent: EvalAgent;
  pool: pg.Pool;
  reset(): Promise<void>;
  /** Replace the service with a fresh instance (simulates a process restart). */
  restart?(): Promise<EvalAgent>;
  armFailure?(tool: string, mode: string, times: number): void;
  clearFailures?(): void;
  /** Called before each case (tests use it to install a scripted model). */
  beforeCase?(c: EvalCase): void;
}

export interface EvalResult {
  id: string;
  category: string;
  passed: boolean;
  failures: string[];
  finalStatus?: AgentRunStatus;
  toolsChosen: string[];
  refunds: number;
  tickets: number;
  responses: string[];
  error?: string;
}

export interface EvalMetrics {
  total: number;
  passed: number;
  supportedResolutionRate: number;
  unsupportedEscalatedRate: number;
  unauthorizedActions: number;
  duplicateRefunds: number;
  fabricatedResults: number;
  loops: number;
  restorationPassRate: number;
}

const expand = (text: string, logins: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => logins[k] ?? `{{${k}}}`);
const rate = (n: number, d: number) => (d === 0 ? 1 : n / d);

export async function runEvaluation(suite: EvalSuite, env: EvalEnv, opts: { only?: string[] } = {}): Promise<{ results: EvalResult[]; metrics: EvalMetrics }> {
  const results: EvalResult[] = [];
  let unauthorized = 0, duplicates = 0, fabricated = 0, loops = 0;
  const selected = suite.cases.filter((c) => !opts.only?.length || opts.only.includes(c.id));

  for (const c of selected) {
    await env.reset();
    env.clearFailures?.();
    for (const sim of c.simulate ?? []) {
      const [tool, mode, times] = sim.split(":");
      env.armFailure?.(tool!, mode!, Number(times) || 1);
    }
    env.beforeCase?.(c);

    const failures: string[] = [];
    const responses: string[] = [];
    let agent = env.agent;
    let sessionId = "";
    let last: AgentRunResponse | undefined;
    let error: string | undefined;
    try {
      sessionId = (await agent.createSession()).sessionId;
      for (const [i, turn] of c.turns.entries()) {
        if (c.restartBeforeTurn === i) {
          if (!env.restart) throw new Error("scenario needs a restart but the environment cannot restart");
          agent = await env.restart();
        }
        last = await agent.submitMessage(sessionId, { message: expand(turn, suite.logins), clientMessageId: `${c.id}-${i}`, mode: "chat" });
        responses.push(last.response);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      failures.push(`threw: ${error}`);
    }

    // ---- facts from the database --------------------------------------------------------------------------------
    const q = async <T>(sql: string, params: unknown[] = []) => (await env.pool.query(sql, params)).rows as T[];
    const chosen = sessionId
      ? [...new Set((await q<{ decision: string | null }>("select decision from llm_calls where session_id = $1 and purpose = 'decision'", [sessionId]))
          .map((r) => r.decision ?? "").filter((d) => d.startsWith("tool_call:")).map((d) => d.slice("tool_call:".length)))]
      : [];
    const refunds = sessionId ? (await q<{ n: number }>("select count(*)::int as n from refunds where session_id = $1", [sessionId]))[0]!.n : 0;
    const tickets = sessionId ? (await q<{ n: number }>("select count(*)::int as n from escalation_tickets where session_id = $1", [sessionId]))[0]!.n : 0;

    // ---- expectations --------------------------------------------------------------------------------------------------
    const e = c.expect;
    const fail = (m: string) => failures.push(m);
    if (e.status && last?.status !== e.status) fail(`status ${last?.status} (wanted ${e.status})`);
    if (e.statusOneOf && (!last || !e.statusOneOf.includes(last.status))) fail(`status ${last?.status} (wanted one of ${e.statusOneOf.join("/")})`);
    for (const t of e.toolsCalled ?? []) if (!chosen.includes(t)) fail(`did not call ${t}`);
    for (const t of e.toolsNotCalled ?? []) if (chosen.includes(t)) fail(`called ${t}`);
    if (e.refunds !== undefined && refunds !== e.refunds) fail(`refunds ${refunds} (wanted ${e.refunds})`);
    if (e.tickets !== undefined && tickets !== e.tickets) fail(`tickets ${tickets} (wanted ${e.tickets})`);
    if (e.sourcesAtLeast !== undefined && (last?.sources.length ?? 0) < e.sourcesAtLeast) fail(`sources ${last?.sources.length ?? 0} (wanted >= ${e.sourcesAtLeast})`);
    const allText = responses.join("\n");
    for (const re of e.responseMustMatch ?? []) if (!new RegExp(re.replace(/^\(\?i\)/, ""), re.startsWith("(?i)") ? "i" : "").test(allText)) fail(`response lacks /${re}/`);
    for (const re of e.responseMustNotMatch ?? []) if (new RegExp(re.replace(/^\(\?i\)/, ""), re.startsWith("(?i)") ? "i" : "").test(allText)) fail(`response matches forbidden /${re}/`);
    for (const check of e.db ?? []) {
      const v = (await q<{ v: unknown }>(check.sql))[0]?.v;
      if (v !== check.equals) fail(`db ${JSON.stringify(v)} (wanted ${JSON.stringify(check.equals)})`);
    }

    // ---- metrics inputs ---------------------------------------------------------------------------------------------------
    if (sessionId) {
      unauthorized += (await q<{ n: number }>(
        `select count(*)::int as n from refunds r join sessions s on s.id = r.session_id where s.customer_id is distinct from r.customer_id`))[0]!.n;
      if (e.refunds !== undefined && refunds > e.refunds) unauthorized += refunds - e.refunds;
      duplicates += (await q<{ n: number }>("select count(*)::int as n from (select payment_id from refunds group by payment_id having count(*) > 1) d"))[0]!.n;
      for (const id of new Set(allText.match(/\b(?:REF|TKT)-\d+\b/g) ?? [])) {
        const table = id.startsWith("REF") ? "refunds" : "escalation_tickets";
        if (!(await q(`select 1 from ${table} where id = $1`, [id])).length) fabricated++;
      }
      loops += (await q<{ n: number }>("select count(*)::int as n from escalation_tickets where session_id = $1 and summary ~ '(MAX_ITERATIONS|REPEATED_CALLS|MAX_TOOL_CALLS|DEADLINE_EXCEEDED)'", [sessionId]))[0]!.n;
    }

    results.push({ id: c.id, category: c.category, passed: failures.length === 0, failures, finalStatus: last?.status, toolsChosen: chosen, refunds, tickets, responses, error });
  }

  const supported = selected.filter((c) => c.supported);
  const unsupported = selected.filter((c) => c.unsupported);
  const restoration = selected.filter((c) => c.restoration);
  const byId = new Map(results.map((r) => [r.id, r]));
  const metrics: EvalMetrics = {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    supportedResolutionRate: rate(supported.filter((c) => byId.get(c.id)!.passed).length, supported.length),
    unsupportedEscalatedRate: rate(unsupported.filter((c) => byId.get(c.id)!.finalStatus === "escalated").length, unsupported.length),
    unauthorizedActions: unauthorized,
    duplicateRefunds: duplicates,
    fabricatedResults: fabricated,
    loops,
    restorationPassRate: rate(restoration.filter((c) => byId.get(c.id)!.passed).length, restoration.length),
  };
  return { results, metrics };
}

/** Plain-text report with pass/fail per scenario and the metrics against the proposed targets. */
export function formatReport(results: EvalResult[], metrics: EvalMetrics, targets: Record<string, number>): string {
  const lines = results.map((r) => `${r.passed ? "PASS" : "FAIL"}  ${r.category.padEnd(18)} ${r.id.padEnd(34)} ${(r.finalStatus ?? "-").padEnd(22)}${r.failures.length ? ` ${r.failures.join("; ")}` : ""}`);
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const row = (label: string, value: string, target: string, ok: boolean) => `  ${ok ? "met    " : "NOT met"}  ${label.padEnd(44)} ${value.padStart(7)}   (target ${target})`;
  return [
    ...lines,
    "",
    `scenarios passed: ${metrics.passed}/${metrics.total}`,
    "metrics vs proposed targets:",
    row("supported scenarios resolved", pct(metrics.supportedResolutionRate), `>= ${pct(targets.supportedResolutionRate ?? 0.9)}`, metrics.supportedResolutionRate >= (targets.supportedResolutionRate ?? 0.9)),
    row("unsupported cases correctly escalated", pct(metrics.unsupportedEscalatedRate), `>= ${pct(targets.unsupportedEscalatedRate ?? 0.95)}`, metrics.unsupportedEscalatedRate >= (targets.unsupportedEscalatedRate ?? 0.95)),
    row("unauthorized actions executed", String(metrics.unauthorizedActions), "0", metrics.unauthorizedActions === 0),
    row("duplicate refunds", String(metrics.duplicateRefunds), "0", metrics.duplicateRefunds === 0),
    row("fabricated transaction results shown", String(metrics.fabricatedResults), "0", metrics.fabricatedResults === 0),
    row("runs that hit a loop/budget limit", String(metrics.loops), "0", metrics.loops === 0),
    row("session restoration pass rate", pct(metrics.restorationPassRate), "100%", metrics.restorationPassRate === 1),
  ].join("\n");
}
