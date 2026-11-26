import type { AgentConfig } from "../config/agent.config.js";
import type { AgentStateType } from "../state/agent-state.js";

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Per-call context block built from backend records and execution counters (never from customer claims). */
export function buildContextBlock(state: AgentStateType, cfg: AgentConfig): string {
  const t = state.trusted;
  const lines = ["TRUSTED CONTEXT (from backend records, not customer claims):"];
  if (state.identityVerified && t) {
    lines.push(`- Identity: verified as customer ${t.customerId}.`);
    if (t.tier) {
      const price = t.monthlyPriceCents !== undefined ? `, ${dollars(t.monthlyPriceCents)}/month` : "";
      lines.push(`- Subscription: ${t.tier} (${t.billingPeriod}), ${t.subscriptionStatus}${price}.`);
    }
    if (t.contractType) lines.push(`- Contract: ${t.contractType}, ${t.contractStatus}.`);
  } else {
    lines.push("- Identity: NOT verified. Account-specific tools will be refused until the customer verifies.");
  }
  if (state.conversationSummary) lines.push(`\nSummary of earlier conversation:\n${state.conversationSummary}`);
  lines.push(`\nEXECUTION BUDGET: decision ${state.iterationCount + 1}/${cfg.maxIterations}, tool calls used ${state.toolCallCount}/${cfg.maxToolCalls}.`);
  if (state.iterationCount + 1 >= cfg.maxIterations - 1) lines.push("You are almost out of budget: respond to the customer or escalate now.");
  return lines.join("\n");
}
