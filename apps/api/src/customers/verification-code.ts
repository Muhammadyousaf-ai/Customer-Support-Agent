import { createHash, timingSafeEqual } from "node:crypto";

/** Mock OTP storage: only a salted hash is persisted. Real deployments would send a one-time code instead. */
export function hashVerificationCode(customerId: string, code: string): string {
  return createHash("sha256").update(`${customerId}:${code}`).digest("hex");
}

export function verificationCodeMatches(customerId: string, code: string, storedHash: string): boolean {
  const a = Buffer.from(hashVerificationCode(customerId, code));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}
