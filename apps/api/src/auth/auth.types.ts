import type { Role } from "../authorization/permissions.js";

export type UserStatus = "pending_verification" | "invited" | "active" | "suspended";

/** The authenticated principal attached to a request. Always reloaded from the database, so a suspension takes effect at once. */
export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  displayName: string;
  customerId: string | null;
  /** Refresh-session id the access token was issued for. */
  sessionId: string;
}

export interface UserRow {
  id: string; email: string; password_hash: string | null; role: Role; status: UserStatus; display_name: string; email_verified_at: Date | null;
  customer_id: string | null; failed_logins: number; locked_until: Date | null; created_at: Date; last_login_at: Date | null;
}

export interface PublicUser { id: string; email: string; role: Role; status: UserStatus; displayName: string; emailVerified: boolean; customerId: string | null; createdAt: string; lastLoginAt: string | null }
export const toPublicUser = (r: UserRow): PublicUser => ({ id: r.id, email: r.email, role: r.role, status: r.status, displayName: r.display_name, emailVerified: Boolean(r.email_verified_at), customerId: r.customer_id, createdAt: r.created_at.toISOString(), lastLoginAt: r.last_login_at?.toISOString() ?? null });

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: AuthUser }
  }
}
