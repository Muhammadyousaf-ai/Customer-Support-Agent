import { describe, expect, it } from "vitest";
import { classifyConfirmationReply } from "../guardrails/confirmation-classifier.js";
import { verifyResponse, type VerificationInput } from "../guardrails/response-verifier.js";
import { SecretVault } from "../guardrails/secret-vault.js";
import { haltReason } from "../policies/execution-budget.js";
import { checkRepeat, classifyToolFailure, signatureOf } from "../policies/tool-selection-policy.js";
import { resolveAgentConfig } from "../config/agent.config.js";
import { loadEnv } from "../../config/env.js";
import { parseDecision } from "../types/agent-decision.js";
import type { LlmResponse } from "../providers/llm-provider.interface.js";
import type { AgentStateType, ToolRecord } from "../state/agent-state.js";

describe("classifyConfirmationReply", () => {
  it.each(["yes", "Yes!", "yep", "yeah please", "sure", "ok", "okay", "confirm", "confirmed", "go ahead", "please do", "do it", "yes please", "Yes, go ahead."])("confirms %j", (t) => {
    expect(classifyConfirmationReply(t)).toBe("confirm");
  });
  it.each(["no", "No.", "nope", "cancel", "stop", "don't", "never mind", "no thanks", "not now"])("declines %j", (t) => {
    expect(classifyConfirmationReply(t)).toBe("decline");
  });
  it.each(["yes and also change my name", "what plan am I on?", "maybe", "", "   ", "yes but only half", "refund PAY-001 instead", "I think so, can you also...", "y"])("treats %j as a different request", (t) => {
    expect(classifyConfirmationReply(t)).toBe("other");
  });
  it("never lets a long message count as a confirmation", () => {
    expect(classifyConfirmationReply(`yes ${"please ".repeat(20)}`)).toBe("other");
  });
});

describe("SecretVault", () => {
  it("replaces codes with stable placeholders and restores them only into verify_identity.verificationCode", () => {
    const v = new SecretVault();
    expect(v.extract("r1", "my code is 482910 (again 482910), order 123456")).toBe("my code is [CODE-1] (again [CODE-1]), order [CODE-2]");
    expect(v.resolveArgs("r1", "verify_identity", { email: "a@b.c", verificationCode: "[CODE-1]" })).toEqual({ email: "a@b.c", verificationCode: "482910" });
  });
  it("never restores a secret into any other tool or field", () => {
    const v = new SecretVault();
    v.extract("r1", "code 482910");
    expect(v.resolveArgs("r1", "create_escalation_ticket", { inquiry: "my code [CODE-1]" })).toEqual({ inquiry: "my code [CODE-1]" });
    expect(v.resolveArgs("r1", "verify_identity", { email: "[CODE-1]", verificationCode: "x" })).toEqual({ email: "[CODE-1]", verificationCode: "x" });
  });
  it("isolates runs and forgets after release", () => {
    const v = new SecretVault();
    v.extract("r1", "code 482910");
    expect(v.resolveArgs("r2", "verify_identity", { verificationCode: "[CODE-1]" })).toEqual({ verificationCode: "[CODE-1]" });
    v.release("r1");
    expect(v.resolveArgs("r1", "verify_identity", { verificationCode: "[CODE-1]" })).toEqual({ verificationCode: "[CODE-1]" });
  });
  it("keeps a code in memory when the email arrives in the next turn of the same session", () => {
    const v = new SecretVault();
    v.extract("r1", "my code is 482910", "s1");
    v.release("r1");
    v.extract("r2", "sarah@example.com", "s1");
    expect(v.resolveArgs("r2", "verify_identity", { verificationCode: "[CODE-1]" })).toEqual({ verificationCode: "482910" });
  });
});

const state = (over: Partial<VerificationInput["state"]> = {}): VerificationInput["state"] => ({
  retrievedDocuments: [{ id: "c1", document: "refund-policy.md", heading: "Monthly subscription refunds", content: "Monthly subscriptions can be refunded within seven days. Up to $100 is approved automatically.", similarity: 0.5 }],
  toolResults: [],
  completedActions: [],
  identityVerified: false,
  retrievalInsufficient: false,
  messages: [{ role: "user", content: "can I get a refund?" }],
  ...over,
});
const rec = (tool: string, summary: string, success = true): ToolRecord => ({ tool, success, signature: "s", epoch: 0, executionId: "e", summary });

describe("verifyResponse", () => {
  it("passes a cited, grounded answer", () => {
    const r = verifyResponse({ response: "Monthly subscriptions can be refunded within seven days.", sourceIds: ["c1"], state: state({ toolResults: [rec("search_knowledge_base", "{}")] }) });
    expect(r.ok).toBe(true);
  });

  it("passes chit-chat and questions with no grounding", () => {
    expect(verifyResponse({ response: "Hello! How can I help you today?", sourceIds: [], state: state() }).ok).toBe(true);
    expect(verifyResponse({ response: "Which payment would you like refunded?", sourceIds: [], state: state() }).ok).toBe(true);
  });

  describe("result verification", () => {
    it.each([
      ["I've processed your refund.", "a refund was issued"],
      ["Your refund has been issued.", "a refund was issued"],
      ["I have refunded you.", "a refund was issued"],
      ["I've created a ticket for you.", "ticket"],
      ["I've updated your display name.", "changed"],
      ["You're now verified.", "verified"],
    ])("rejects %j when no tool confirmed it", (response, mention) => {
      const r = verifyResponse({ response, sourceIds: [], state: state() });
      expect(r.ok).toBe(false);
      expect(r.failures[0]!.reason).toContain(mention);
    });
    it("accepts the same claims once a tool confirmed them", () => {
      const done = state({ completedActions: [{ type: "refund", ref: "REF-001", detail: "x" }], toolResults: [rec("issue_refund", '{"refundId":"REF-001","amountCents":4900}')] });
      expect(verifyResponse({ response: "I've processed your refund REF-001 of $49.", sourceIds: [], state: done }).ok).toBe(true);
    });
    it("does not mistake a description of policy for a claim of action", () => {
      expect(verifyResponse({ response: "Refunds are processed within 5 to 10 business days.", sourceIds: ["c1"], state: state({ retrievedDocuments: [{ id: "c1", document: "d", heading: "h", content: "Refunds typically appear within 5 to 10 business days.", similarity: 1 }] }) }).ok).toBe(true);
    });
  });

  describe("fabricated details", () => {
    it("rejects an invented reference id, amount, or policy number", () => {
      expect(verifyResponse({ response: "Your refund REF-123 is on its way.", sourceIds: [], state: state() }).failures.some((f) => f.reason.includes("REF-123"))).toBe(true);
      expect(verifyResponse({ response: "That costs $999.", sourceIds: [], state: state() }).failures.some((f) => f.reason.includes("$999"))).toBe(true);
      expect(verifyResponse({ response: "Refunds are allowed within 45 days.", sourceIds: ["c1"], state: state() }).failures.some((f) => f.reason.includes("45 days"))).toBe(true);
    });
    it("accepts ids and amounts that appear in tool results, in dollars or cents", () => {
      const s = state({ toolResults: [rec("get_payment_history", '{"paymentId":"PAY-002","amountCents":4900,"amount":49}')] });
      expect(verifyResponse({ response: "Your payment PAY-002 was $49.00.", sourceIds: [], state: s }).ok).toBe(true);
    });
    it("accepts numbers the customer themself provided", () => {
      const s = state({ messages: [{ role: "user", content: "I was charged $19 on PAY-001" }] });
      expect(verifyResponse({ response: "I see you mention $19 on PAY-001.", sourceIds: [], state: s }).ok).toBe(true);
    });
  });

  describe("grounding of policy claims", () => {
    const claim = "Our refund policy allows refunds only if they are permitted.";
    it("fails with scope when nothing was retrieved", () => {
      expect(verifyResponse({ response: claim, sourceIds: [], state: state() }).failures[0]!.guardrail).toBe("scope");
    });
    it("fails with retrieval_confidence when retrieval found nothing supported", () => {
      const s = state({ toolResults: [rec("search_knowledge_base", "{}")], retrievalInsufficient: true });
      expect(verifyResponse({ response: claim, sourceIds: [], state: s }).failures[0]!.guardrail).toBe("retrieval_confidence");
    });
    it("fails with evidence_verification when sources exist but were not cited, or cited ones were never retrieved", () => {
      const s = state({ toolResults: [rec("search_knowledge_base", "{}")] });
      expect(verifyResponse({ response: claim, sourceIds: [], state: s }).failures[0]!.guardrail).toBe("evidence_verification");
      expect(verifyResponse({ response: claim, sourceIds: ["nope"], state: s }).failures.some((f) => f.reason.includes("never retrieved"))).toBe(true);
    });
    it("accepts an eligibility statement backed by the backend's own decision", () => {
      const s = state({ toolResults: [rec("check_refund_eligibility", '{"decision":"eligible"}')] });
      expect(verifyResponse({ response: "Your payment is eligible for a refund.", sourceIds: [], state: s }).ok).toBe(true);
    });
  });
});

describe("tool-selection policy", () => {
  const record = (over: Partial<ToolRecord>): ToolRecord => ({ tool: "t", success: true, signature: signatureOf("t", { a: 1 }, 0), epoch: 0, executionId: "e", summary: "", ...over });
  it("signatures ignore key order and change with the world state", () => {
    expect(signatureOf("t", { a: 1, b: 2 }, 0)).toBe(signatureOf("t", { b: 2, a: 1 }, 0));
    expect(signatureOf("t", { a: 1 }, 0)).not.toBe(signatureOf("t", { a: 1 }, 1));
  });
  it("blocks repeating a success or a non-retryable failure, but allows a retry of a retryable one", () => {
    const sig = signatureOf("t", { a: 1 }, 0);
    expect(checkRepeat([record({})], sig).blocked).toBe(true);
    expect(checkRepeat([record({ success: false, retryable: false })], sig).blocked).toBe(true);
    expect(checkRepeat([record({ success: false, retryable: true })], sig).blocked).toBe(false);
    expect(checkRepeat([record({ success: false, retryable: true }), record({ success: false, retryable: true }), record({ success: false, retryable: true })], sig).blocked).toBe(true);
    expect(checkRepeat([], sig).blocked).toBe(false);
  });
  it("classifies failures for recovery", () => {
    expect(classifyToolFailure("IDENTITY_REQUIRED", false)).toBe("needs_identity");
    expect(classifyToolFailure("DATABASE_UNAVAILABLE", true)).toBe("db_unavailable");
    expect(classifyToolFailure("TOOL_TIMEOUT", true)).toBe("transient");
    expect(classifyToolFailure("ACCESS_DENIED", false)).toBe("permanent");
  });
});

describe("execution budget", () => {
  const cfg = resolveAgentConfig(loadEnv({}));
  const s = (over: Partial<AgentStateType>) => ({ iterationCount: 0, toolCallCount: 0, startedAtMs: 0, ...over }) as AgentStateType;
  const ok = { cancelled: false, deadlineExceeded: false };
  it("uses the spec's starting limits", () => {
    expect(cfg).toMatchObject({ maxIterations: 12, maxToolCalls: 15, maxEvidenceRetries: 1, maxRetrievalRefinements: 1, deadlineMs: 60_000, llmTimeoutMs: 20_000, llmMaxRetries: 2 });
  });
  it("halts on iterations, tool calls, deadline and cancellation, in that precedence for cancellation first", () => {
    expect(haltReason(s({}), cfg, ok)).toBeNull();
    expect(haltReason(s({ iterationCount: 12 }), cfg, ok)).toBe("iterations");
    expect(haltReason(s({ toolCallCount: 15 }), cfg, ok)).toBe("tool_budget");
    expect(haltReason(s({ startedAtMs: 1 }), cfg, ok, 1 + 60_001)).toBe("deadline");
    expect(haltReason(s({}), cfg, { cancelled: false, deadlineExceeded: true })).toBe("deadline");
    expect(haltReason(s({ iterationCount: 99 }), cfg, { cancelled: true, deadlineExceeded: true })).toBe("cancelled");
  });
});

describe("parseDecision", () => {
  const res = (toolCalls: LlmResponse["toolCalls"], content: string | null = null): LlmResponse => ({ content, toolCalls, usage: { inputTokens: 0, outputTokens: 0 }, latencyMs: 0, model: "m" });
  it("maps every function to a typed decision", () => {
    expect(parseDecision(res([{ id: "1", name: "get_subscription", arguments: "{}" }]))).toMatchObject({ ok: true, decision: { type: "tool_call", toolName: "get_subscription" } });
    expect(parseDecision(res([{ id: "1", name: "respond_to_customer", arguments: '{"response":"hi","sourceIds":["a"]}' }]))).toMatchObject({ ok: true, decision: { type: "respond", sourceIds: ["a"] } });
    expect(parseDecision(res([{ id: "1", name: "ask_customer_for_info", arguments: '{"question":"q"}' }]))).toMatchObject({ ok: true, decision: { type: "clarify", requiredFields: [] } });
    expect(parseDecision(res([{ id: "1", name: "request_customer_confirmation", arguments: '{"toolName":"issue_refund","arguments":{"paymentId":"PAY-1"}}' }]))).toMatchObject({ ok: true, decision: { type: "confirm_action" } });
    expect(parseDecision(res([{ id: "1", name: "escalate_to_human", arguments: '{"reason":"r","category":"billing","summary":"s"}' }]))).toMatchObject({ ok: true, decision: { type: "escalate" } });
  });
  it("rejects bad JSON, unknown tools, missing required fields and empty replies; treats plain text as an unsourced response", () => {
    expect(parseDecision(res([{ id: "1", name: "get_subscription", arguments: "{oops" }]))).toMatchObject({ ok: false, toolCallId: "1" });
    expect(parseDecision(res([{ id: "1", name: "drop_tables", arguments: "{}" }]))).toMatchObject({ ok: false });
    expect(parseDecision(res([{ id: "1", name: "respond_to_customer", arguments: "{}" }]))).toMatchObject({ ok: false });
    expect(parseDecision(res([]))).toMatchObject({ ok: false });
    expect(parseDecision(res([], "just text"))).toMatchObject({ ok: true, decision: { type: "respond", response: "just text", sourceIds: [] } });
  });
});
