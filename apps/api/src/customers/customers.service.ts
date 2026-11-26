import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { z } from "zod";
import { AuditService } from "../audit/audit.service.js";
import { PG_POOL } from "../database/tokens.js";
import { MAX_VERIFY_ATTEMPTS, SessionsService } from "../sessions/sessions.service.js";
import { ToolError } from "../tools/errors/tool-error.js";
import { hashVerificationCode, verificationCodeMatches } from "./verification-code.js";

export interface CustomerRecord {
  id: string;
  name: string;
  displayName: string;
  email: string;
  status: "active" | "expired" | "suspended";
}

interface CustomerRow {
  id: string; name: string; display_name: string; email: string; status: CustomerRecord["status"]; verification_code_hash: string;
}

const NOTIFICATIONS = z.object({ email: z.boolean(), sms: z.boolean(), marketing: z.boolean() }).partial().strict();
const FIELD_VALIDATORS = {
  // eslint-disable-next-line no-control-regex -- intentionally rejecting control characters
  displayName: z.string().trim().min(1).max(80).refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "contains control characters"),
  timezone: z.string().refine((tz) => {
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
  }, "not a valid IANA time zone"),
  language: z.enum(["en", "es", "fr", "de", "pt", "it", "ja"]),
  notificationPreferences: NOTIFICATIONS.refine((o) => Object.keys(o).length > 0, "no preferences given"),
} as const;
export type UpdatableField = keyof typeof FIELD_VALIDATORS;
export const UPDATABLE_FIELDS = Object.keys(FIELD_VALIDATORS) as UpdatableField[];

const COLUMN: Record<UpdatableField, string> = {
  displayName: "display_name", timezone: "timezone", language: "language", notificationPreferences: "notification_preferences",
};
/** Fields that need a human (additional verification), as opposed to fields that are simply never editable. */
const APPROVAL_FIELDS = new Set(["billingEmail"]);

@Injectable()
export class CustomersService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async getById(id: string): Promise<CustomerRecord | null> {
    const { rows } = await this.pool.query<CustomerRow>("select * from customers where id = $1", [id]);
    return rows[0] ? this.toRecord(rows[0]) : null;
  }

  /**
   * Mock OTP verification bound to the backend session. Wrong email and wrong code are indistinguishable
   * (no account enumeration), and attempts are counted per session and capped.
   */
  async verifyIdentity(sessionId: string, email: string, code: string): Promise<{ customerId: string; name: string }> {
    const attempts = await this.sessions.recordVerifyAttempt(sessionId);
    if (attempts > MAX_VERIFY_ATTEMPTS) {
      throw new ToolError("ACCESS_DENIED", "Too many failed verification attempts. Please contact a human agent.");
    }
    const { rows } = await this.pool.query<CustomerRow>("select * from customers where lower(email) = lower($1)", [email]);
    const customer = rows[0];
    // Compare against a dummy hash when the email is unknown so both paths cost the same.
    const matches = verificationCodeMatches(
      customer?.id ?? "CUST-000",
      code,
      customer?.verification_code_hash ?? hashVerificationCode("CUST-000", "000000"),
    );
    if (!customer || !matches) {
      throw new ToolError("VERIFICATION_FAILED", "The email or verification code is incorrect.", false, {
        attemptsRemaining: Math.max(0, MAX_VERIFY_ATTEMPTS - attempts),
      });
    }
    const session = await this.sessions.get(sessionId);
    if (session?.identityVerified && session.customerId && session.customerId !== customer.id) {
      throw new ToolError("ACCESS_DENIED", "This session is already verified as a different customer.");
    }
    await this.sessions.markVerified(sessionId, customer.id);
    await this.audit.log({ sessionId, customerId: customer.id, actor: "agent", action: "identity.verified", entityType: "session", entityId: sessionId });
    return { customerId: customer.id, name: customer.name };
  }

  /** Pure validation, shared by the write path and the agent's confirmation preflight. Throws ToolError. */
  validateUpdate(field: string, value: unknown): { key: UpdatableField; value: unknown } {
    if (APPROVAL_FIELDS.has(field)) {
      throw new ToolError("MANUAL_APPROVAL_REQUIRED", `Changing "${field}" needs additional verification by a human agent.`, false, { field });
    }
    if (!UPDATABLE_FIELDS.includes(field as UpdatableField)) {
      throw new ToolError("ACCESS_DENIED", `The field "${field}" cannot be changed by the support agent.`, false, { field, allowedFields: UPDATABLE_FIELDS });
    }
    const key = field as UpdatableField;
    const parsed = FIELD_VALIDATORS[key].safeParse(value);
    if (!parsed.success) throw new ToolError("INVALID_ARGUMENTS", `Invalid value for ${key}: ${z.prettifyError(parsed.error)}`);
    return { key, value: parsed.data };
  }

  /** Allow-listed account update. The previous and new value are audited in the same transaction. */
  async updateField(sessionId: string, customerId: string, field: string, value: unknown) {
    const { key, value: parsedValue } = this.validateUpdate(field, value);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const column = COLUMN[key];
      const { rows } = await client.query<{ current: unknown }>(`select ${column} as current from customers where id = $1 for update`, [customerId]);
      if (!rows[0]) throw new ToolError("CUSTOMER_NOT_FOUND", "Customer not found.");
      const previous = rows[0].current;
      const next = key === "notificationPreferences" ? { ...(previous as object), ...(parsedValue as object) } : parsedValue;
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        await client.query(`update customers set ${column} = $2, updated_at = now() where id = $1`, [customerId, key === "notificationPreferences" ? JSON.stringify(next) : next]);
        await this.audit.log({ sessionId, customerId, actor: "agent", action: `account.${key}.updated`, entityType: "customer", entityId: customerId, previousValue: previous, newValue: next }, client);
      }
      await client.query("commit");
      return { field: key, previousValue: previous, newValue: next, changed: JSON.stringify(previous) !== JSON.stringify(next) };
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  private toRecord(r: CustomerRow): CustomerRecord {
    return { id: r.id, name: r.name, displayName: r.display_name, email: r.email, status: r.status };
  }
}
