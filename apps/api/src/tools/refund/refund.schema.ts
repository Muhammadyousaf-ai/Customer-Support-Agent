import { z } from "zod";

export const checkRefundInput = z.object({
  paymentId: z.string().regex(/^PAY-[A-Z0-9-]+$/, "must look like PAY-001"),
  amountCents: z.number().int().positive().max(100_000_000).optional(),
});
export type CheckRefundInput = z.infer<typeof checkRefundInput>;

export const issueRefundInput = checkRefundInput.extend({ reason: z.string().trim().max(500).optional() });
export type IssueRefundInput = z.infer<typeof issueRefundInput>;
