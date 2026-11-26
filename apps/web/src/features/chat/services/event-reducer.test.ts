import type { AgentEventType, SseEnvelope } from "@support-ai/contracts";
import { describe, expect, it } from "vitest";
import { hydrateFromSession, initialEventState, reduceEvent, type ChatEventState } from "./event-reducer";

let seq = 0;
const ev = (type: AgentEventType, payload: unknown, runId = "r1", sequence = ++seq): SseEnvelope => ({ eventId: `s:${sequence}`, sessionId: "s", runId, sequence, type, timestamp: "t", payload });
const apply = (events: SseEnvelope[], from: ChatEventState = initialEventState()) => events.reduce(reduceEvent, from);
const tool = (n: string, id = `call_${n}`) => ({ tool: n, toolCallId: id, executionId: `e_${n}` });

describe("event reducer", () => {
  it("renders whichever tools the agent actually selects, in the order it selected them", () => {
    seq = 0;
    const s = apply([
      ev("run.started", { mode: "chat", resumed: false }),
      ev("tool.started", { ...tool("get_payment_history"), attempt: 1 }),
      ev("tool.completed", { ...tool("get_payment_history"), durationMs: 12, status: "success" }),
      ev("tool.started", { ...tool("some_future_tool"), attempt: 1 }),
      ev("tool.failed", { ...tool("some_future_tool"), durationMs: 5, errorCode: "ACCESS_DENIED" }),
    ]);
    const run = s.runs.r1!;
    expect(run.tools.map((t) => [t.tool, t.status])).toEqual([["get_payment_history", "completed"], ["some_future_tool", "failed"]]);
    expect(run.tools[0]).toMatchObject({ durationMs: 12 });
    expect(run.tools[1]).toMatchObject({ errorCode: "ACCESS_DENIED" });
  });

  it("shows a retry when a tool starts again with a higher attempt, then its final outcome", () => {
    seq = 0;
    const s = apply([ev("run.started", { mode: "chat", resumed: false }), ev("tool.started", { ...tool("x", "c1"), attempt: 1 }), ev("tool.started", { ...tool("x", "c1"), attempt: 2 })]);
    expect(s.runs.r1!.tools).toHaveLength(1);
    expect(s.runs.r1!.tools[0]).toMatchObject({ status: "retrying", attempt: 2 });
    const done = apply([ev("tool.completed", { ...tool("x", "c1"), attempt: 2, durationMs: 40 })], s);
    expect(done.runs.r1!.tools[0]).toMatchObject({ status: "completed", attempt: 2 });
  });

  it("ignores duplicate and out-of-order events (replay after reconnect)", () => {
    seq = 0;
    const events = [ev("run.started", { mode: "chat", resumed: false }), ev("tool.started", { ...tool("a"), attempt: 1 }), ev("tool.completed", { ...tool("a"), durationMs: 1 })];
    const once = apply(events);
    const twice = apply(events, once); // the whole stream replayed
    expect(twice).toBe(once);
    expect(apply([events[1]!], once)).toBe(once);
    expect(once.lastSequence).toBe(3);
  });

  it("builds streamed text from deltas and finalizes it with the persisted message id", () => {
    seq = 0;
    const s = apply([ev("run.started", { mode: "chat", resumed: false }), ev("response.delta", { text: "Your pay" }), ev("response.delta", { text: "ment is fine." })]);
    expect(s.runs.r1).toMatchObject({ status: "streaming", streamingText: "Your payment is fine." });
    const done = apply([ev("response.completed", { text: "Your payment is fine.", messageId: 42 }), ev("run.completed", { status: "completed", durationMs: 9 })], s);
    expect(done.runs.r1).toMatchObject({ status: "completed", finalText: "Your payment is fine.", messageId: 42 });
  });

  it("holds a pending confirmation, shows it as awaiting, and only reports a refund after the backend result", () => {
    seq = 0;
    const paused = apply([
      ev("run.started", { mode: "chat", resumed: false }),
      ev("confirmation.required", { actionId: "ACT-1", type: "refund", summary: "Refund $49.00 for payment PAY-002", amountCents: 4900, currency: "USD", expiresAt: "x", display: { Customer: "CUST-002" } }),
      ev("run.paused", { reason: "awaiting_confirmation" }),
    ]);
    const r = paused.runs.r1!;
    expect(r.status).toBe("awaiting_confirmation");
    expect(r.pendingAction).toMatchObject({ id: "ACT-1", amountCents: 4900 });
    expect(r.tools.find((t) => t.status === "awaiting_confirmation")).toBeTruthy();
    expect(r.refund).toBeUndefined(); // never displayed as done before the confirmed result

    const resumed = apply([
      ev("run.started", { mode: "chat", resumed: true }),
      ev("tool.started", { ...tool("issue_refund"), attempt: 1 }),
      ev("tool.completed", { ...tool("issue_refund"), durationMs: 60, result: { refundId: "REF-001", paymentId: "PAY-002", amountCents: 4900, currency: "USD", simulated: true } }),
    ], paused);
    const after = resumed.runs.r1!;
    expect(after.pendingAction).toBeNull();
    expect(after.refund).toMatchObject({ refundId: "REF-001", amountCents: 4900 });
    expect(after.tools.some((t) => t.status === "awaiting_confirmation")).toBe(false);
  });

  it("collects sources (best similarity per section), guardrails, tickets, clarification and usage", () => {
    seq = 0;
    const s = apply([
      ev("run.started", { mode: "chat", resumed: false }),
      ev("retrieval.completed", { query: "q", status: "grounded", confidenceScore: 0.4, sources: [{ document: "refund-policy.md", heading: "Monthly", similarity: 0.3 }] }),
      ev("retrieval.completed", { query: "q2", status: "grounded", confidenceScore: 0.5, sources: [{ document: "refund-policy.md", heading: "Monthly", similarity: 0.5 }] }),
      ev("guardrail.passed", { guardrail: "scope" }),
      ev("guardrail.failed", { guardrail: "evidence_verification", reason: "uncited", action: "retry" }),
      ev("guardrail.passed", { guardrail: "evidence_verification" }),
      ev("escalation.created", { ticketId: "TKT-001", reason: "OTHER", priority: "normal" }),
      ev("clarification.required", { question: "Which payment?", requiredFields: ["paymentId"] }),
      ev("usage.updated", { inputTokens: 1, outputTokens: 2, llmCalls: 3, estimatedCostUsd: 0.01 }),
    ]);
    const r = s.runs.r1!;
    expect(r.sources).toEqual([{ document: "refund-policy.md", heading: "Monthly", similarity: 0.5 }]);
    expect(r.guardrails.find((g) => g.guardrail === "evidence_verification")?.passed).toBe(true); // latest result wins
    expect(r.ticket).toMatchObject({ ticketId: "TKT-001", status: "open" });
    expect(r.clarification).toEqual({ question: "Which payment?", requiredFields: ["paymentId"] });
    expect(r.status).toBe("awaiting_input");
    expect(r.usage?.llmCalls).toBe(3);
  });

  it("marks unfinished tools explicitly when a run is cancelled or fails", () => {
    seq = 0;
    const base = [ev("run.started", { mode: "chat", resumed: false }), ev("tool.started", { ...tool("slow"), attempt: 1 })];
    expect(apply([...base, ev("run.cancelled", { reconciledActions: [] })]).runs.r1).toMatchObject({ status: "cancelled", tools: [expect.objectContaining({ status: "cancelled" })] });
    seq = 2;
    expect(apply([ev("run.failed", { errorCode: "X", message: "boom" })], apply(base.map((e, i) => ({ ...e, sequence: i + 1 })))).runs.r1).toMatchObject({ status: "failed", error: { message: "boom" }, tools: [expect.objectContaining({ status: "failed" })] });
  });

  it("keeps separate runs separate and tracks the active one", () => {
    seq = 0;
    const s = apply([ev("run.started", { mode: "chat", resumed: false }, "a"), ev("run.completed", { status: "completed", durationMs: 1 }, "a"), ev("run.started", { mode: "chat", resumed: false }, "b")]);
    expect(s.order).toEqual(["a", "b"]);
    expect(s.activeRunId).toBe("b");
    expect(s.runs.a!.status).toBe("completed");
  });

  it("hydrates a paused run from the session view so a refresh shows the confirmation before the stream replays", () => {
    const pendingAction = { id: "ACT-1", type: "refund" as const, summary: "Refund", expiresAt: "x", display: {} };
    const s = hydrateFromSession(initialEventState(), { activeRun: { runId: "r9", status: "awaiting_confirmation" }, pendingAction });
    expect(s.runs.r9).toMatchObject({ status: "awaiting_confirmation", pendingAction });
    expect(hydrateFromSession(s, { activeRun: { runId: "r9", status: "running" }, pendingAction: null })).toBe(s); // does not clobber events
  });
});
