/**
 * Friendly names for tools the agent may call. This is a presentation hint only: the activity list renders whatever
 * tools the agent actually used, in the order it used them, and unknown tools fall back to a readable form of the name.
 */
const LABELS: Record<string, { running: string; done: string }> = {
  verify_identity: { running: "Verifying customer identity", done: "Verified customer identity" },
  get_subscription: { running: "Checking subscription tier", done: "Checked subscription tier" },
  get_contract: { running: "Retrieving contract details", done: "Retrieved contract details" },
  get_payment_history: { running: "Reviewing payment history", done: "Reviewed payment history" },
  search_knowledge_base: { running: "Searching knowledge base", done: "Searched knowledge base" },
  check_refund_eligibility: { running: "Checking refund eligibility", done: "Checked refund eligibility" },
  issue_refund: { running: "Processing simulated refund", done: "Processed simulated refund" },
  update_account: { running: "Updating account details", done: "Updated account details" },
  create_escalation_ticket: { running: "Creating support ticket", done: "Created support ticket" },
};

export const humanize = (tool: string) => tool.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function toolLabel(tool: string, finished: boolean): string {
  const l = LABELS[tool];
  return l ? (finished ? l.done : l.running) : humanize(tool);
}
