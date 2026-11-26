import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type pg from "pg";
import { AuditService } from "../audit/audit.service.js";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";
import { PG_POOL } from "../database/tokens.js";
import { UsersService } from "../users/users.service.js";
import type { AuthUser, PublicUser, UserRow } from "./auth.types.js";
import { toPublicUser } from "./auth.types.js";
import { MailService } from "./mail.service.js";
import { PasswordService } from "./password.service.js";
import { TokenService } from "./token.service.js";

export interface RequestInfo { ip?: string; userAgent?: string }
export interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number; user: PublicUser }

const DAY = 86_400_000;
const GENERIC_LOGIN_ERROR = "Invalid email or password.";

/** Registration, login, refresh rotation with reuse detection, password reset, invitations, session management. */
@Injectable()
export class AuthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  get requireEmailVerification(): boolean {
    return (this.env.REQUIRE_EMAIL_VERIFICATION ?? (this.env.NODE_ENV === "production" ? "true" : "false")) === "true";
  }

  private link(path: string, token: string): string {
    return `${this.env.WEB_ORIGIN.split(",")[0]!.trim()}${path}?token=${token}`;
  }

  private async issueToken(userId: string, purpose: "verify_email" | "reset_password" | "invite", ttlMs: number): Promise<string> {
    const s = this.tokens.newSecret();
    await this.pool.query("insert into auth_tokens (user_id, purpose, token_hash, expires_at) values ($1,$2,$3, now() + make_interval(secs => $4))", [userId, purpose, s.hash, ttlMs / 1000]);
    return s.token;
  }

  private async consumeToken(token: string, purpose: string): Promise<string> {
    const { rows } = await this.pool.query<{ user_id: string }>(
      "update auth_tokens set used_at = now() where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now() returning user_id", [this.tokens.hashSecret(token), purpose],
    );
    if (!rows[0]) throw new BadRequestException("This link is invalid or has expired.");
    return rows[0].user_id;
  }

  // ---- registration and verification --------------------------------------------------------------------------------------
  /** Customers register themselves. There is deliberately no way to ask for another role here. */
  async register(input: { email: string; password: string; displayName: string }): Promise<{ user: PublicUser; verificationRequired: boolean }> {
    const verify = this.requireEmailVerification;
    const user = await this.users.create({ email: input.email, passwordHash: await this.passwords.hash(input.password), role: "customer", status: verify ? "pending_verification" : "active", displayName: input.displayName, emailVerified: !verify });
    await this.audit.log({ actor: "user", actorUserId: user.id, actorRole: "customer", action: "auth.registered", entityType: "user", entityId: user.id });
    if (verify) {
      const token = await this.issueToken(user.id, "verify_email", 2 * DAY);
      await this.mail.send(user.email, "Verify your email", `Welcome! Confirm your email: ${this.link("/verify-email", token)}`, "verify_email");
    }
    return { user: toPublicUser(user), verificationRequired: verify };
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.consumeToken(token, "verify_email");
    await this.pool.query("update users set email_verified_at = now(), status = case when status = 'pending_verification' then 'active' else status end, updated_at = now() where id = $1", [userId]);
    await this.audit.log({ actor: "user", actorUserId: userId, action: "auth.email_verified", entityType: "user", entityId: userId });
  }

  // ---- login / refresh / logout ---------------------------------------------------------------------------------------------
  async login(email: string, password: string, info: RequestInfo): Promise<TokenPair> {
    const user = await this.users.findByEmail(email);
    if (!user) {
      await this.passwords.verifyDummy(password); // same cost as a real check: no account enumeration by timing
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) throw new HttpException("Too many failed sign-in attempts. Try again later.", HttpStatus.TOO_MANY_REQUESTS);
    if (!(await this.passwords.verify(user.password_hash, password))) {
      const { rows } = await this.pool.query<{ failed_logins: number }>(
        `update users set failed_logins = failed_logins + 1,
           locked_until = case when failed_logins + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end where id = $1 returning failed_logins`,
        [user.id, this.env.LOGIN_MAX_FAILURES, this.env.LOGIN_LOCK_MINUTES],
      );
      await this.audit.log({ actor: "system", action: "auth.login_failed", entityType: "user", entityId: user.id, newValue: { failures: rows[0]?.failed_logins } });
      throw new UnauthorizedException(GENERIC_LOGIN_ERROR);
    }
    // Only now (the password was right) say anything specific about the account state.
    if (user.status === "suspended") throw new ForbiddenException("This account is suspended. Contact an administrator.");
    if (user.status === "invited") throw new ForbiddenException("Finish setting up your account with the invitation link first.");
    if (user.status === "pending_verification") throw new ForbiddenException("Please verify your email address first.");
    await this.pool.query("update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1", [user.id]);
    await this.audit.log({ actor: "user", actorUserId: user.id, actorRole: user.role, action: "auth.login", entityType: "user", entityId: user.id });
    return this.startSession(user, info);
  }

  private async startSession(user: UserRow, info: RequestInfo, familyId?: string): Promise<TokenPair> {
    const refresh = this.tokens.newSecret();
    const { rows } = await this.pool.query<{ id: string; family_id: string }>(
      `insert into auth_sessions (user_id, family_id, refresh_hash, user_agent, ip, expires_at)
       values ($1, coalesce($2::uuid, gen_random_uuid()), $3, $4, $5, now() + make_interval(secs => $6)) returning id, family_id`,
      [user.id, familyId ?? null, refresh.hash, info.userAgent?.slice(0, 200) ?? null, info.ip ?? null, (this.env.REFRESH_TOKEN_TTL_DAYS * DAY) / 1000],
    );
    const accessToken = await this.tokens.signAccess({ sub: user.id, role: user.role, sid: rows[0]!.id });
    return { accessToken, refreshToken: refresh.token, expiresIn: this.tokens.accessTtlSeconds, user: toPublicUser(user) };
  }

  /**
   * Rotates the refresh token. Presenting a token that was already rotated means it was copied: the whole family (every
   * descendant of that login) is revoked, so a thief and the real user are both forced to sign in again.
   */
  async refresh(refreshToken: string, info: RequestInfo): Promise<TokenPair> {
    const hash = this.tokens.hashSecret(refreshToken);
    const { rows } = await this.pool.query<{ id: string; user_id: string; family_id: string; revoked_at: Date | null; replaced_by: string | null; expires_at: Date }>("select * from auth_sessions where refresh_hash = $1", [hash]);
    const s = rows[0];
    if (!s) throw new UnauthorizedException("Session expired. Please sign in again.");
    if (s.revoked_at || s.replaced_by) {
      if (s.replaced_by) {
        await this.pool.query("update auth_sessions set revoked_at = now(), revoked_reason = 'refresh_token_reuse' where family_id = $1 and revoked_at is null", [s.family_id]);
        await this.audit.log({ actor: "system", action: "auth.refresh_reuse_detected", entityType: "user", entityId: s.user_id, newValue: { familyId: s.family_id } });
      }
      throw new UnauthorizedException("Session expired. Please sign in again.");
    }
    if (s.expires_at.getTime() <= Date.now()) throw new UnauthorizedException("Session expired. Please sign in again.");
    const user = await this.users.findById(s.user_id);
    if (!user || user.status !== "active") throw new UnauthorizedException("Session expired. Please sign in again.");
    // Claim the old token atomically: of two concurrent refreshes with the same token only one wins.
    const claimed = await this.pool.query("update auth_sessions set revoked_at = now(), revoked_reason = 'rotated', last_used_at = now() where id = $1 and revoked_at is null and replaced_by is null returning id", [s.id]);
    if (!claimed.rows[0]) throw new UnauthorizedException("Session expired. Please sign in again.");
    const next = await this.startSession(user, info, s.family_id);
    const nextId = (await this.tokens.verifyAccess(next.accessToken))!.sid;
    await this.pool.query("update auth_sessions set replaced_by = $2 where id = $1", [s.id, nextId]);
    return next;
  }

  async logout(refreshToken: string | undefined, user?: AuthUser): Promise<void> {
    if (refreshToken) await this.pool.query("update auth_sessions set revoked_at = now(), revoked_reason = 'logout' where refresh_hash = $1 and revoked_at is null", [this.tokens.hashSecret(refreshToken)]);
    else if (user) await this.pool.query("update auth_sessions set revoked_at = now(), revoked_reason = 'logout' where id = $1 and revoked_at is null", [user.sessionId]);
  }

  async revokeAll(userId: string, reason = "logout_all"): Promise<void> {
    await this.pool.query("update auth_sessions set revoked_at = now(), revoked_reason = $2 where user_id = $1 and revoked_at is null", [userId, reason]);
  }

  async listSessions(userId: string, currentId: string) {
    const { rows } = await this.pool.query("select id, user_agent, ip, created_at, last_used_at from auth_sessions where user_id = $1 and revoked_at is null and replaced_by is null and expires_at > now() order by created_at desc", [userId]);
    return rows.map((r) => ({ id: r.id as string, userAgent: r.user_agent as string | null, ip: r.ip as string | null, createdAt: (r.created_at as Date).toISOString(), lastUsedAt: (r.last_used_at as Date).toISOString(), current: r.id === currentId }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.pool.query("update auth_sessions set revoked_at = now(), revoked_reason = 'revoked_by_user' where id = $1 and user_id = $2 and revoked_at is null", [sessionId, userId]);
  }

  /** Validates an access token and loads the live user, so suspension and logout are immediate. */
  async authenticate(accessToken: string): Promise<AuthUser | null> {
    const claims = await this.tokens.verifyAccess(accessToken);
    if (!claims) return null;
    const { rows } = await this.pool.query<UserRow & { session_ok: boolean }>(
      `select u.*, exists(select 1 from auth_sessions s where s.id = $2 and s.user_id = u.id and s.revoked_at is null and s.expires_at > now()) as session_ok from users u where u.id = $1`,
      [claims.sub, claims.sid],
    );
    const u = rows[0];
    if (!u || u.status !== "active" || !u.session_ok) return null;
    return { id: u.id, email: u.email, role: u.role, status: u.status, displayName: u.display_name, customerId: u.customer_id, sessionId: claims.sid };
  }

  // ---- invitations, password change (self-service reset removed: no mail provider is wired up) ---------------------------------------------------------------------------------------
  /** Staff are created by an admin as "invited"; they choose their own password through this one-time link. */
  async acceptInvite(token: string, password: string): Promise<void> {
    const userId = await this.consumeToken(token, "invite");
    await this.setPasswordAndActivate(userId, password, "auth.invite_accepted");
  }

  private async setPasswordAndActivate(userId: string, password: string, action: string): Promise<void> {
    const hash = await this.passwords.hash(password);
    await this.pool.query(
      `update users set password_hash = $2, failed_logins = 0, locked_until = null, email_verified_at = coalesce(email_verified_at, now()),
         status = case when status in ('invited','pending_verification') then 'active' else status end, updated_at = now() where id = $1`, [userId, hash],
    );
    await this.revokeAll(userId, "password_changed"); // every device must sign in again
    await this.audit.log({ actor: "user", actorUserId: userId, action, entityType: "user", entityId: userId });
  }

  async createInvitation(userId: string, email: string, displayName: string): Promise<string> {
    const token = await this.issueToken(userId, "invite", 7 * DAY);
    await this.mail.send(email, "You have been invited to the support team", `Hi ${displayName}, set your password: ${this.link("/reset-password", token)}&invite=1`, "invite");
    return token;
  }

  async changePassword(user: AuthUser, current: string, next: string): Promise<void> {
    const row = await this.users.require(user.id);
    if (!(await this.passwords.verify(row.password_hash, current))) throw new UnauthorizedException("Current password is incorrect.");
    if (current === next) throw new ConflictException("Choose a different password.");
    await this.setPasswordAndActivate(user.id, next, "auth.password_changed");
  }
}
