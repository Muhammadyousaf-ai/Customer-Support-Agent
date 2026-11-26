export const TIERS = ["free", "basic", "pro", "enterprise"] as const;
export type Tier = (typeof TIERS)[number];

export const BILLING_PERIODS = ["monthly", "annual"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export const POLICY_CATEGORIES = [
  "refund",
  "subscription",
  "cancellation",
  "technical",
  "account",
  "billing",
  "escalation",
] as const;
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

export interface PolicyChunk {
  id: string;
  documentId: string;
  content: string;
  heading: string;
  category: PolicyCategory;
  applicableTiers: Tier[];
  contractTypes: BillingPeriod[];
  policyVersion: string;
}
