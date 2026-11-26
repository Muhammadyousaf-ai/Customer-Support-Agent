import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { callTool, respond, type ScriptedResponder } from "../providers/scripted-llm.provider.js";
import { buildAgentHarness, codePlaceholder, count, firstSourceId, pool, refundIdFrom, type AgentHarness } from "./agent-harness.js";

const toolNames = async (runId: string) =>
  (await pool.query("select tool from tool_executions where run_id = $1 order by created_at", [runId])).rows.map((r) => r.tool as string);

/** The customer's whole refund conversation, as a model might autonomously drive it. */
const refundScript: ScriptedResponder[] = [
  (req) => callTool("verify_identity", { email: "sarah@example.com", verificationCode: codePlaceholder(req) }),
  () => callTool("get_payment_history", {}),
  () => callTool("search_knowledge_base", { query: "refund policy for a recent monthly payment" }),
  () => callTool("check_refund_eligibility", { paymentId: "PAY-002" }),
  () => callTool("issue_refund", { paymentId: "PAY-002" }), // the backend intercepts this and asks the customer to confirm
  (req) => respond(`Your refund ${refundIdFrom(req)} of $49 has been processed.`, [firstSourceId(req)]),
];

describe.skipIf(false)("agent orchestration (real graph, PostgreSQL, scripted model)", () => {
  let h: AgentHarness;
  beforeAll(async () => {
    h = await buildAgentHarness({ script: refundScript, cfg: { tracePrompts: true } });
    await h.ingest();
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await h.reset();
    // each test replays the script from the start
    h.llm.decisionRequests.length = 0;
    h.llm.allRequests.length = 0;
  });

  it("autonomously chains tools, pauses for confirmation, then completes the refund after the customer says yes", async () => {
    const s = await h.session();
    const first = await s.say("Hi, I was charged yesterday but I barely use the app. Can I get my money back? I'm sarah@example.com, code 482910");

    expect(first.status).toBe("awaiting_confirmation");
    expect(first.pendingAction).toMatchObject({ type: "refund", amountCents: 4900, currency: "USD" });
    expect(first.response).toContain("$49.00");
    expect(await count("refunds")).toBe(0); // nothing executed before the customer confirms
    expect(first.metrics.toolCalls).toBeGreaterThanOrEqual(5);

    const second = await s.say("yes");
    expect(second.status).toBe("completed");
    expect(second.response).toContain("REF-001");
    expect(second.sources[0]).toMatchObject({ document: "refund-policy.md" });
    expect(await count("refunds")).toBe(1);

    const tools = await toolNames(first.runId);
    expect(tools).toEqual(expect.arrayContaining(["verify_identity", "get_payment_history", "search_knowledge_base", "check_refund_eligibility", "issue_refund"]));
    expect(second.runId).toBe(first.runId); // one run, paused and resumed
  });

  it("never lets the verification code reach the model, the messages table, traces, tool logs or checkpoints", async () => {
    const s = await h.session();
    await s.say("Refund please. I'm sarah@example.com, my code is 482910");
    await s.say("yes");
    const everything = JSON.stringify(h.llm.allRequests.map((r) => ({ system: r.system, messages: r.messages })));
    expect(everything).not.toContain("482910");
    expect(everything).toContain("[CODE-1]");
    for (const table of ["messages", "trace_events", "llm_calls", "tool_executions", "audit_logs", "pending_actions", "checkpoints", "checkpoint_blobs", "checkpoint_writes"]) {
      const { rows } = await pool.query(`select t::text as row from ${table} t`);
      expect(JSON.stringify(rows), table).not.toContain("482910");
    }
    // ...and yet verification worked, because the real value was substituted only at tool execution time.
    expect(await count("sessions", "identity_verified = true")).toBe(1);
  });
});
