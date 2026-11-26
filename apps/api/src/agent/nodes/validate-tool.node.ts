import { ToolError } from "../../tools/errors/tool-error.js";
import { actionIdFor, hashArguments } from "../memory/pending-actions.service.js";
import { checkRepeat, CONFIRMATION_REQUIRED, signatureOf } from "../policies/tool-selection-policy.js";
import type { AgentStateType, AgentStateUpdate, PendingActionState, ToolRecord } from "../state/agent-state.js";
import { emit, toolMessage, type AgentDeps } from "./node-deps.js";
import { runTool } from "./tool-runner.js";

const MAX_BLOCKED_REPEATS = 3;
const DECISION_TO_CODE = { rejected: "REFUND_NOT_ELIGIBLE", manual_approval_required: "MANUAL_APPROVAL_REQUIRED", escalate: "POLICY_NOT_FOUND" } as const;
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

interface Check { decision: keyof typeof DECISION_TO_CODE | "eligible"; explanation: string; reasonCode: string; paymentId: string; amountCents: number; refundableCents: number; currency: string }

/**
 * Validates a proposed tool call before anything runs:
 *  - the tool exists; the same call is not being pointlessly repeated (loop prevention)
 *  - sensitive write tools get a backend preflight (refund eligibility, field allow-list) and then require the
 *    customer's explicit, action-bound confirmation. Nothing sensitive can reach execute_tool without it.
 * Ordinary calls pass straight through. Rejections go back to the model as structured tool errors.
 */
export const createValidateToolNode = (d: AgentDeps) => async (state: AgentStateType): Promise<AgentStateUpdate> => {
  const call = state.pendingToolCall;
  if (!call) return {};

  /** Rejects the call, tells the model why, and records it so later logic (loop prevention, ticket reasons) can see it. */
  const block = (code: string, message: string, extra: AgentStateUpdate = {}, details?: unknown): AgentStateUpdate => {
    const error = { code, message, ...(details ? { details } : {}) };
    const alreadyRecorded = Array.isArray(extra.toolResults) && extra.toolResults.length > 0;
    return {
      pendingToolCall: null,
      lastToolOutcome: { tool: call.name, success: false, errorCode: code, retryable: false, blocked: true },
      messages: [toolMessage(call.id, { success: false, error })],
      ...extra,
      toolResults: [
        ...(alreadyRecorded ? (extra.toolResults as ToolRecord[]) : []),
        { tool: call.name, success: false, errorCode: code, retryable: false, signature: signatureOf(call.name, call.arguments, state.stateEpoch), epoch: state.stateEpoch, executionId: "blocked", summary: JSON.stringify(error).slice(0, 2000) },
      ],
    };
  };

  if (!d.registry.find(call.name)) {
    return block("TOOL_NOT_FOUND", `"${call.name}" is not an available tool. Available: ${d.registry.list().map((t) => t.name).join(", ")}.`);
  }
  if (state.toolCallCount >= d.cfg.maxToolCalls) return { halt: "tool_budget" };

  const repeat = checkRepeat(state.toolResults, signatureOf(call.name, call.arguments, state.stateEpoch));
  if (repeat.blocked) {
    const blocked = state.blockedRepeats + 1;
    emit(d, state, "guardrail.failed", { guardrail: "business_validation", reason: `repeated call to ${call.name} blocked`, action: "block" });
    return block("REPEATED_CALL_BLOCKED", repeat.reason, { blockedRepeats: blocked, ...(blocked >= MAX_BLOCKED_REPEATS ? { halt: "blocked_repeats" as const } : {}) });
  }

  if (!CONFIRMATION_REQUIRED.has(call.name)) return {};

  // ---- sensitive action: backend preflight, then confirmation -------------------------------------------------
  const ttl = new Date(Date.now() + d.cfg.confirmationTtlMs).toISOString();
  const t = state.trusted;
  const baseDisplay: Record<string, string> = {
    ...(state.customerId ? { Customer: state.customerId } : {}),
    ...(t?.tier ? { Subscription: `${t.tier} \u00b7 ${t.billingPeriod}` } : {}),
  };
  let pending: PendingActionState;
  let extra: AgentStateUpdate = {};

  if (call.name === "issue_refund") {
    const args = call.arguments as { paymentId?: unknown; amountCents?: unknown };
    if (typeof args.paymentId !== "string") return block("INVALID_ARGUMENTS", "issue_refund needs a paymentId (for example PAY-002).");
    const checkInput = { paymentId: args.paymentId, ...(typeof args.amountCents === "number" ? { amountCents: args.amountCents } : {}) };
    const { result, record } = await runTool(d, state, { name: "check_refund_eligibility", input: checkInput, toolCallId: `${call.id}:preflight` });
    extra = { toolCallCount: state.toolCallCount + 1, toolResults: [record] };
    if (!result.success) {
      return block(result.error!.code, result.error!.message, extra, result.error!.details);
    }
    const check = result.data as Check;
    if (check.decision !== "eligible") {
      emit(d, state, "guardrail.failed", { guardrail: "business_validation", reason: `${check.reasonCode}: ${check.explanation}`, action: "block" });
      return block(DECISION_TO_CODE[check.decision], check.explanation, extra, { decision: check.decision, reasonCode: check.reasonCode });
    }
    emit(d, state, "guardrail.passed", { guardrail: "business_validation", detail: `refund of ${check.paymentId} is eligible` });
    const amountCents = typeof args.amountCents === "number" ? args.amountCents : check.refundableCents;
    const clean = { paymentId: check.paymentId, ...(typeof args.amountCents === "number" ? { amountCents } : {}) };
    pending = {
      actionId: actionIdFor(state.runId, call.id), type: "refund", toolName: "issue_refund", toolCallId: call.id, arguments: clean, argumentsHash: hashArguments("issue_refund", clean),
      summary: `Refund ${dollars(amountCents)} for payment ${check.paymentId}`, amountCents, currency: check.currency, expiresAt: ttl,
      display: { ...baseDisplay, "Payment reference": check.paymentId, Eligibility: "Verified by backend rules", "Action type": "Simulated refund" },
    };
  } else {
    const args = call.arguments as { field?: unknown; value?: unknown };
    if (typeof args.field !== "string") return block("INVALID_ARGUMENTS", "update_account needs a field and a value.");
    if (!state.identityVerified) return block("IDENTITY_REQUIRED", "The customer must verify their identity before account changes.");
    try {
      d.customers.validateUpdate(args.field, args.value);
    } catch (err) {
      if (err instanceof ToolError) return block(err.code, err.message, {}, err.details);
      throw err;
    }
    const clean = { field: args.field, value: args.value };
    pending = {
      actionId: actionIdFor(state.runId, call.id), type: "account_update", toolName: "update_account", toolCallId: call.id, arguments: clean, argumentsHash: hashArguments("update_account", clean),
      summary: `Change your ${args.field} to ${JSON.stringify(args.value)}`, expiresAt: ttl,
      display: { ...baseDisplay, Field: args.field, "New value": JSON.stringify(args.value) },
    };
  }
  return { ...extra, pendingConfirmation: pending, confirmedActionId: null };
};
