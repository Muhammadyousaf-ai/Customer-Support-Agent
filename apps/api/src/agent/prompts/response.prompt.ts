import type { AgentStateType } from "../state/agent-state.js";

/** Feedback sent back to the model when its drafted answer is rejected by a guardrail. */
export function verificationFeedback(failures: Array<{ guardrail: string; reason: string }>): string {
  return [
    "Your proposed answer was NOT released to the customer because it failed verification:",
    ...failures.map((f) => `- [${f.guardrail}] ${f.reason}`),
    "Revise it using only retrieved policy text and tool results, cite sourceIds for policy claims, and do not claim any action succeeded unless a tool confirmed it. If you cannot, call escalate_to_human.",
  ].join("\n");
}

/** Backend-authored text for outcomes the model must not word itself (what actually happened). */
export const BackendMessages = {
  escalated: (ticketId: string, priority: string) =>
    `I'm not able to resolve this myself, so I've passed it to our support team. Your ticket reference is ${ticketId} (priority: ${priority}). A human agent will follow up with you.`,
  customerRequestedHuman: (ticketId: string) =>
    `Of course. I've passed your conversation to our support team, and a member of the team will reply here. Your ticket reference is ${ticketId}.`,
  escalationFailed: () => "I'm sorry, I couldn't complete your request and I also wasn't able to create a support ticket just now. Please try again in a few minutes.",
  recoveredAndEscalated: (ticketId: string) =>
    `I'm sorry, I ran into a problem while working on this. I've created ticket ${ticketId} so a human agent can follow up with you.`,
  verificationFailedEscalated: (ticketId: string) =>
    `I couldn't verify a reliable answer to your question, so I've passed it to our support team instead of guessing. Your ticket reference is ${ticketId}.`,
  cancelled: (completed: AgentStateType["completedActions"]) =>
    completed.length
      ? `Okay, I've stopped. Note that these actions had already completed before you cancelled: ${completed.map((a) => a.detail).join("; ")}.`
      : "Okay, I've stopped. Nothing was changed on your account.",
  declined: () => "No problem, I haven't made any changes.",
};
