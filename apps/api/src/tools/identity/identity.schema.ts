import { z } from "zod";

export const verifyIdentityInput = z.object({
  email: z.email().max(254),
  verificationCode: z.string().regex(/^\d{6}$/, "must be the 6 digit verification code"),
});
export type VerifyIdentityInput = z.infer<typeof verifyIdentityInput>;
