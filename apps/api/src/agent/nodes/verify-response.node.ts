import { GUARDRAIL_NAMES, type GuardrailName } from "@support-ai/contracts";
import { evidenceForLlm, verifyResponse, type GuardrailFailure } from "../guardrails/response-verifier.js";
import { verificationFeedback } from "../prompts/response.prompt.js";
import type { AgentStateType, AgentStateUpdate } from "../state/agent-state.js";
import { emit, toolMessage, type AgentDeps } from "./node-deps.js";

/**
 * Nothing reaches the customer until this node approves it. The model's draft is checked by deterministic
 * guardrails (result claims, fabricated ids/amounts/policy numbers, grounding and citations) and, when a model is
 * available, a second opinion on whether it is supported by the evidence. Failure gives the model one chance to
 * revise; after that the case is escalated instead of guessing.
 */
export const createVerifyResponseNode = (d: AgentDeps) => async (state: AgentStateType): Promise<AgentStateUpdate> => {
  const decision = state.decision;
  if (decision?.type !== "respond") return {};

  const outcome = verifyResponse({ response: decision.response, sourceIds: decision.sourceIds, state });
  const failures: GuardrailFailure[] = [...outcome.failures];
  let usage = state.usage;

  if (outcome.ok && d.evidence.enabled && decision.sourceIds.length > 0) {
    const verdict = await d.evidence.check(decision.response, evidenceForLlm(state, decision.sourceIds), d.runRegistry.signal(state.runId));
    usage = { ...usage, inputTokens: usage.inputTokens + verdict.inputTokens, outputTokens: usage.outputTokens + verdict.outputTokens, llmCalls: usage.llmCalls + (verdict.ran ? 1 : 0) };
    if (verdict.ran && !verdict.supported) {
      failures.push({ guardrail: "evidence_verification", reason: `A second check found claims not supported by the evidence: ${verdict.unsupportedClaims.join("; ") || "unspecified"}.` });
    }
  }

  const failedNames = new Set<GuardrailName>(failures.map((f) => f.guardrail));
  for (const g of GUARDRAIL_NAMES) {
    if (outcome.passed.includes(g) && !failedNames.has(g)) emit(d, state, "guardrail.passed", { guardrail: g });
  }

  if (failures.length === 0) {
    const cited = decision.sourceIds.filter((id) => state.retrievedDocuments.some((x) => x.id === id));
    return { draftResponse: decision.response, finalResponse: decision.response, citedSourceIds: cited, evidenceVerified: true, status: "completed", usage };
  }

  const canRetry = state.verificationAttempts < d.cfg.maxEvidenceRetries;
  for (const f of failures) emit(d, state, "guardrail.failed", { guardrail: f.guardrail, reason: f.reason, action: canRetry ? "retry" : "escalate" });

  if (canRetry) {
    // The model's respond call needs an answer in the transcript; the answer is the rejection and why.
    const call = decision.toolCallId;
    return {
      usage, verificationAttempts: state.verificationAttempts + 1, decision: null, draftResponse: null,
      messages: call ? [toolMessage(call, { success: false, error: { code: "RESPONSE_REJECTED", message: verificationFeedback(failures) } })] : [{ role: "system", content: verificationFeedback(failures) }],
    };
  }
  return {
    usage, errorCode: "VERIFICATION_FAILED", draftResponse: null,
    decision: { type: "escalate", reason: "Could not produce a verified, grounded answer", category: "other", summary: `Answer failed verification: ${failures.map((f) => `[${f.guardrail}] ${f.reason}`).join(" ").slice(0, 700)}` },
  };
};
