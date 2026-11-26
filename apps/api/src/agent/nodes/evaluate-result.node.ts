import { classifyToolFailure } from "../policies/tool-selection-policy.js";
import type { AgentStateType, AgentStateUpdate } from "../state/agent-state.js";
import { systemNote, type AgentDeps } from "./node-deps.js";

const MAX_FAILURE_STREAK = 3;

/**
 * Looks at what the last step produced and decides how the loop continues. Counters and halting conditions live
 * here; guidance for the model is appended as a system note so it can adapt rather than follow a fixed script.
 */
export const createEvaluateResultNode = (d: AgentDeps) => async (state: AgentStateType): Promise<AgentStateUpdate> => {
  const out = state.lastToolOutcome;
  if (!out) return {};
  const update: AgentStateUpdate = { lastToolOutcome: null };
  const notes: string[] = [];

  if (out.success) {
    update.failureStreak = 0;
    if (out.tool === "search_knowledge_base") {
      if (state.retrievalInsufficient) {
        if (state.retrievalRefinements < d.cfg.maxRetrievalRefinements) {
          update.retrievalRefinements = state.retrievalRefinements + 1;
          notes.push("The policy search did not find sufficiently supported evidence. You may refine the query once (more specific wording). If it still finds nothing, do not answer from your own knowledge: ask the customer for clarification or escalate.");
        } else {
          notes.push("The policy search found no sufficiently supported evidence, and the refinement limit is reached. You must NOT state any policy. Ask a clarifying question if one could help, otherwise call escalate_to_human.");
        }
      }
    }
    return { ...update, ...(notes.length ? { messages: [systemNote(notes.join(" "))] } : {}) };
  }

  const streak = state.failureStreak + 1;
  update.failureStreak = streak;
  const kind = classifyToolFailure(out.errorCode, out.retryable);

  if (kind === "db_unavailable") {
    // Stop sensitive operations: the database is not reliable right now, so no more tools. The recovery node
    // reports honestly and tries to create a ticket once.
    return { ...update, halt: "db_unavailable", errorCode: "DATABASE_UNAVAILABLE" };
  }
  if (streak >= MAX_FAILURE_STREAK) return { ...update, halt: "failure_streak", errorCode: out.errorCode ?? "TOOL_FAILURES" };

  if (kind === "needs_identity") {
    notes.push("The customer is not verified (or verification failed). Ask them for the email on their account and the 6 digit verification code with ask_customer_for_info. Do not call account tools again until they have provided it.");
  } else if (out.errorCode === "MANUAL_APPROVAL_REQUIRED" || out.errorCode === "POLICY_NOT_FOUND") {
    notes.push("The backend says this needs human approval or has no applicable policy. Do not retry or work around it. Explain briefly and call escalate_to_human.");
  } else if (out.errorCode === "REFUND_NOT_ELIGIBLE") {
    notes.push("The backend decided this is not eligible and that decision is final. Explain the reason to the customer using the tool result; do not try to refund anyway.");
  } else if (kind === "permanent") {
    notes.push("That tool failed and will not succeed if repeated. Try a different approach, ask the customer for what is missing, or escalate.");
  } else if (kind === "transient") {
    notes.push("That tool failed temporarily. You may try once more if it is still needed.");
  }
  return { ...update, ...(notes.length ? { messages: [systemNote(notes.join(" "))] } : {}) };
};
