import { createHash } from "node:crypto";
import { canonicalJson } from "../../tools/middleware/idempotency.service.js";
import type { ToolRecord } from "../state/agent-state.js";

/** Write tools that always need the customer's explicit, action-bound confirmation first. */
export const CONFIRMATION_REQUIRED: ReadonlySet<string> = new Set(["issue_refund", "update_account"]);

/** Tool + normalised arguments + world-state epoch. The same signature in the same epoch is a pointless repeat. */
export function signatureOf(tool: string, args: unknown, epoch: number): string {
  return createHash("sha256").update(`${tool}|${canonicalJson(args)}|${epoch}`).digest("hex").slice(0, 24);
}

export type RepeatVerdict = { blocked: false } | { blocked: true; reason: string };

/**
 * Loop prevention. Blocked: repeating a call that already succeeded in the same epoch, or one that failed for a
 * non-retryable reason. Allowed: a retry after a retryable failure, or any call after the world state changed.
 */
export function checkRepeat(previous: ToolRecord[], signature: string, maxRetries = 2): RepeatVerdict {
  const same = previous.filter((r) => r.signature === signature);
  if (same.some((r) => r.success)) {
    return { blocked: true, reason: "This exact call already succeeded and nothing has changed since. Use the earlier result instead of repeating it." };
  }
  const failures = same.filter((r) => !r.success);
  if (failures.some((r) => !r.retryable)) {
    return { blocked: true, reason: "This exact call already failed and will fail the same way. Change the arguments, use another tool, ask the customer, or escalate." };
  }
  if (failures.length > maxRetries) return { blocked: true, reason: "This call has failed repeatedly. Stop retrying it." };
  return { blocked: false };
}

/** Failure classes the recovery policy distinguishes. */
export type FailureClass = "needs_identity" | "db_unavailable" | "transient" | "permanent";
export function classifyToolFailure(code: string | undefined, retryable: boolean | undefined): FailureClass {
  if (code === "IDENTITY_REQUIRED" || code === "VERIFICATION_FAILED") return "needs_identity";
  if (code === "DATABASE_UNAVAILABLE") return "db_unavailable";
  return retryable ? "transient" : "permanent";
}
