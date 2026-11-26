import type { AgentStateType, AgentStateUpdate } from "../state/agent-state.js";
import { emit, type AgentDeps } from "./node-deps.js";

/**
 * The model needs something from the customer. The turn ends here with status "awaiting_input"; the question is
 * saved as the assistant's message, and the customer's answer arrives as the next message in the same session, where
 * the conversation memory carries the context forward.
 */
export const createClarificationNode = (d: AgentDeps) => async (state: AgentStateType): Promise<AgentStateUpdate> => {
  const decision = state.decision;
  if (decision?.type !== "clarify") return {};
  emit(d, state, "clarification.required", { question: decision.question, requiredFields: decision.requiredFields });
  return { finalResponse: decision.question, clarificationQuestion: decision.question, status: "awaiting_input" };
};
