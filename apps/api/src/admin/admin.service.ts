import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { AssignmentMode } from "@support-ai/contracts";
import type pg from "pg";
import { AuditService } from "../audit/audit.service.js";
import { AuthService } from "../auth/auth.service.js";
import type { AuthUser } from "../auth/auth.types.js";
import { toPublicUser } from "../auth/auth.types.js";
import { BudgetService } from "../budget/budget.service.js";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";
import { PG_POOL } from "../database/tokens.js";
import { TicketsService } from "../tickets/tickets.service.js";
import { UsersService } from "../users/users.service.js";

const num = (v: unknown) => Number(v ?? 0);

/** Administration: staff and customer accounts, system-wide ticket figures, audit log, settings. */
@Injectable()
export class AdminService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(BudgetService) private readonly budget: BudgetService,
  ) {}

  // ---- staff ------------------------------------------------------------------------------------------------------------------
  /** Staff are invited, never self-registered: the account exists without a password until they accept the one-time link. */
  async createStaff(admin: AuthUser, input: { email: string; displayName: string }) {
    const user = await this.users.create({ email: input.email, passwordHash: null, role: "staff", status: "invited", displayName: input.displayName, createdBy: admin.id });
    await this.auth.createInvitation(user.id, user.email, user.display_name);
    await this.audit.log({ actor: "user", actorUserId: admin.id, actorRole: "admin", action: "staff.invited", entityType: "user", entityId: user.id, newValue: { email: user.email } });
    return toPublicUser(user);
  }

  /** Suspend/activate a staff or customer account. Admins cannot be changed through the API, and nobody can change themselves. */
  async setStatus(admin: AuthUser, userId: string, status: "active" | "suspended") {
    if (userId === admin.id) throw new ForbiddenException("You cannot change your own account status.");
    const target = await this.users.require(userId);
    if (target.role === "admin") throw new ForbiddenException("Administrator accounts cannot be changed through the API.");
    if (target.status === "invited" && status === "active") throw new ConflictException("This staff member has not accepted the invitation yet.");
    const updated = await this.users.setStatus(userId, status);
    if (status === "suspended") {
      await this.auth.revokeAll(userId, "suspended"); // signed out everywhere immediately
      // Hand their open work back to the queue instead of leaving it with someone who cannot act.
      if (target.role === "staff") {
        const { rows } = await this.pool.query<{ id: string }>("select id from escalation_tickets where assigned_staff_id = $1 and status in ('assigned','in_progress','waiting_customer','pending_review')", [userId]);
        for (const r of rows) await this.tickets.assign(r.id, null, admin, "unassign");
      }
    }
    await this.audit.log({ actor: "user", actorUserId: admin.id, actorRole: "admin", action: status === "suspended" ? "user.suspended" : "user.activated", entityType: "user", entityId: userId, previousValue: { status: target.status }, newValue: { status } });
    return toPublicUser(updated);
  }

  async resendInvite(admin: AuthUser, userId: string): Promise<void> {
    const u = await this.users.require(userId);
    if (u.role !== "staff" || u.status !== "invited") throw new BadRequestException("Only pending staff invitations can be re-sent.");
    await this.auth.createInvitation(u.id, u.email, u.display_name);
    await this.audit.log({ actor: "user", actorUserId: admin.id, actorRole: "admin", action: "staff.invite_resent", entityType: "user", entityId: userId });
  }

  // ---- customers ----------------------------------------------------------------------------------------------------------------
  async customers(q?: string, limit = 50, offset = 0) {
    const args: unknown[] = [];
    let where = "where u.role = 'customer'";
    if (q) { args.push(`%${q.toLowerCase()}%`); where += ` and (lower(u.email) like $1 or lower(u.display_name) like $1)`; }
    args.push(Math.min(limit, 200), offset);
    const { rows } = await this.pool.query(
      `select u.*, (select count(*) from sessions s where s.user_id = u.id) conversations, (select count(*) from escalation_tickets t where t.user_id = u.id) tickets
       from users u ${where} order by u.created_at desc limit $${args.length - 1} offset $${args.length}`, args,
    );
    return rows.map((r) => ({ ...toPublicUser(r), conversations: num(r.conversations), tickets: num(r.tickets) }));
  }

  async customerConversations(userId: string) {
    const u = await this.users.require(userId);
    if (u.role !== "customer") throw new NotFoundException("Customer not found.");
    const { rows } = await this.pool.query("select id, title, created_at, handover_mode, (select count(*) from messages m where m.session_id = s.id) messages from sessions s where s.user_id = $1 order by created_at desc limit 100", [userId]);
    return rows.map((r) => ({ id: r.id as string, title: r.title as string | null, createdAt: (r.created_at as Date).toISOString(), handoverMode: r.handover_mode as string, messages: num(r.messages) }));
  }

  // ---- overview -----------------------------------------------------------------------------------------------------------------
  async overview() {
    const [byStatus, byPriority, times, runs, esc, users, staff] = await Promise.all([
      this.pool.query("select status, count(*) n from escalation_tickets group by status"),
      this.pool.query("select priority, count(*) n from escalation_tickets where status not in ('resolved','closed') group by priority"),
      this.pool.query(`select coalesce(avg(extract(epoch from (resolved_at - created_at)) / 60) filter (where resolved_at is not null),0) res, coalesce(avg(extract(epoch from (first_response_at - created_at)) / 60) filter (where first_response_at is not null),0) frt from escalation_tickets`),
      this.pool.query("select count(*) n from agent_runs where started_at > now() - interval '7 days'"),
      this.pool.query("select count(*) n from escalation_tickets where created_at > now() - interval '7 days' and source in ('ai_chat','ai_voice')"),
      this.pool.query("select role, count(*) n from users group by role"),
      this.users.staffList(),
    ]);
    const status = Object.fromEntries(byStatus.rows.map((r) => [r.status, num(r.n)])) as Record<string, number>;
    const total = Object.values(status).reduce((a, b) => a + b, 0);
    const done = (status.resolved ?? 0) + (status.closed ?? 0);
    return {
      tickets: { total, byStatus: status, unassigned: status.open ?? 0, openByPriority: Object.fromEntries(byPriority.rows.map((r) => [r.priority, num(r.n)])), resolutionRate: total ? Number((done / total).toFixed(3)) : null, avgResolutionMinutes: Math.round(num(times.rows[0].res)), avgFirstResponseMinutes: Math.round(num(times.rows[0].frt)) },
      ai: { runs7d: num(runs.rows[0].n), escalations7d: num(esc.rows[0].n), escalationRate: num(runs.rows[0].n) ? Number((num(esc.rows[0].n) / num(runs.rows[0].n)).toFixed(3)) : null, budget: await this.budget.status() },
      users: Object.fromEntries(users.rows.map((r) => [r.role, num(r.n)])),
      staff,
    };
  }

  // ---- audit log and settings -------------------------------------------------------------------------------------------------
  async auditLogs(f: { action?: string; entityType?: string; actor?: string; limit?: number; offset?: number }) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.action) { args.push(`${f.action}%`); where.push(`a.action like $${args.length}`); }
    if (f.entityType) { args.push(f.entityType); where.push(`a.entity_type = $${args.length}`); }
    if (f.actor) { args.push(f.actor); where.push(`a.actor_user_id = $${args.length}::uuid`); }
    const w = where.length ? `where ${where.join(" and ")}` : "";
    const total = num((await this.pool.query(`select count(*) n from audit_logs a ${w}`, args)).rows[0].n);
    args.push(Math.min(f.limit ?? 50, 200), f.offset ?? 0);
    const { rows } = await this.pool.query(
      `select a.id, a.actor, a.actor_role, a.action, a.entity_type, a.entity_id, a.previous_value, a.new_value, a.created_at, u.display_name actor_name
       from audit_logs a left join users u on u.id = a.actor_user_id ${w} order by a.id desc limit $${args.length - 1} offset $${args.length}`, args,
    );
    return { total, entries: rows.map((r) => ({ id: num(r.id), actor: r.actor as string, actorRole: r.actor_role as string | null, actorName: r.actor_name as string | null, action: r.action as string, entityType: r.entity_type as string, entityId: r.entity_id as string, previous: r.previous_value, next: r.new_value, at: (r.created_at as Date).toISOString() })) };
  }

  async settings() {
    const e = this.env;
    return {
      assignmentMode: await this.tickets.assignmentMode(),
      // Read-only: these come from the deployment environment, changing them is a deploy decision, not a runtime toggle.
      ai: { textModel: e.OPENAI_CHAT_MODEL, embeddingModel: e.OPENAI_EMBEDDING_MODEL, liveModel: e.OPENAI_REALTIME_MODEL, retrievalMinSimilarity: e.RETRIEVAL_MIN_SIMILARITY ?? "calibrated default (see docs/rag.md)", maxIterations: e.AGENT_MAX_ITERATIONS, maxToolCalls: e.AGENT_MAX_TOOL_CALLS, deadlineMs: e.AGENT_DEADLINE_MS, maxAutoRefundUsd: e.MAX_AUTO_REFUND_USD, dailyBudgetUsd: e.DAILY_AI_BUDGET_USD, voiceMaxMinutes: e.VOICE_MAX_SESSION_MINUTES },
    };
  }

  async setAssignmentMode(admin: AuthUser, mode: AssignmentMode) {
    await this.tickets.setAssignmentMode(mode, admin);
    return { assignmentMode: mode };
  }

  /** Development aid: the mail that would have been sent (invitation / reset / verification links). Not available in production. */
  async outbox() {
    if (this.env.NODE_ENV === "production") throw new NotFoundException();
    const { rows } = await this.pool.query("select id, to_address, subject, body, purpose, created_at from email_outbox order by id desc limit 50");
    return rows.map((r) => ({ id: num(r.id), to: r.to_address as string, subject: r.subject as string, body: r.body as string, purpose: r.purpose as string | null, at: (r.created_at as Date).toISOString() }));
  }
}
