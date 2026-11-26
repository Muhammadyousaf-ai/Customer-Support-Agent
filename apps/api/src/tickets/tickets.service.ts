import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { TICKET_TRANSITIONS, type AssignmentMode, type HandoverMode, type TicketDetail, type TicketPriority, type TicketStatus, type TicketSummary } from "@support-ai/contracts";
import type pg from "pg";
import { AuditService } from "../audit/audit.service.js";
import type { AuthUser } from "../auth/auth.types.js";
import { containsPattern } from "../common/like.js";
import { PG_POOL } from "../database/tokens.js";
import { NotificationsService } from "../notifications/notifications.service.js";

export type Actor = { kind: "user"; user: AuthUser } | { kind: "session"; sessionId: string };
type Level = "admin" | "assigned" | "staff_limited" | "customer";
type Db = Pick<pg.Pool, "query">;

const ACTIVE = ["assigned", "in_progress", "waiting_customer", "pending_review"] as const;
const SELECT = `select t.*, s.display_name as staff_name, c.display_name as cust_name, c.email as cust_email
                from escalation_tickets t left join users s on s.id = t.assigned_staff_id left join users c on c.id = t.user_id`;

interface TicketRow {
  id: string; session_id: string; user_id: string | null; customer_id: string | null; category: string; priority: TicketPriority; reason: string; summary: string; inquiry: string | null;
  status: TicketStatus; subject: string | null; ai_summary: string | null; source: string; assigned_staff_id: string | null; assigned_at: Date | null; first_response_at: Date | null;
  resolved_at: Date | null; resolution: string | null; created_at: Date; updated_at: Date; staff_name: string | null; cust_name: string | null; cust_email: string | null;
}

/**
 * Ticket lifecycle on top of the existing AI escalation ticket. Everything that changes a ticket happens in one transaction with
 * its status history, assignment record, audit row and the conversation's handover mode, so they cannot disagree.
 */
@Injectable()
export class TicketsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  // ---- visibility --------------------------------------------------------------------------------------------------------------
  private levelOf(t: TicketRow, actor: Actor): Level | null {
    if (actor.kind === "session") return t.session_id === actor.sessionId ? "customer" : null;
    const u = actor.user;
    if (u.role === "admin") return "admin";
    if (u.role === "customer") return t.user_id === u.id ? "customer" : null;
    if (t.assigned_staff_id === u.id) return "assigned";
    return t.assigned_staff_id === null && t.status === "open" ? "staff_limited" : null;
  }

  private async load(id: string, db: Db = this.pool, lock = false): Promise<TicketRow> {
    const { rows } = await db.query<TicketRow>(`${SELECT} where t.id = $1 ${lock ? "for update of t" : ""}`, [id]);
    if (!rows[0]) throw new NotFoundException("Ticket not found.");
    return rows[0];
  }

  /** 404 (not 403) for a ticket the caller may not see, so ticket ids cannot be probed. */
  private async visible(id: string, actor: Actor, db: Db = this.pool): Promise<{ t: TicketRow; level: Level }> {
    const t = await this.load(id, db);
    const level = this.levelOf(t, actor);
    if (!level) throw new NotFoundException("Ticket not found.");
    return { t, level };
  }

  private summary(t: TicketRow, level: Level): TicketSummary {
    const base: TicketSummary = {
      id: t.id, subject: t.subject ?? t.summary.slice(0, 80), category: t.category, priority: t.priority, status: t.status, source: t.source, reason: t.reason,
      createdAt: t.created_at.toISOString(), updatedAt: t.updated_at.toISOString(), assignedStaff: t.assigned_staff_id ? { id: t.assigned_staff_id, displayName: t.staff_name ?? "" } : null, aiSummary: t.ai_summary ?? t.summary,
    };
    // Unassigned tickets show staff only what they need to decide whether to take it: no customer identity, no conversation.
    if (level === "staff_limited") return base;
    return { ...base, customer: { id: t.customer_id, displayName: t.cust_name, email: level === "customer" ? null : t.cust_email } };
  }

  // ---- reads -------------------------------------------------------------------------------------------------------------------
  async list(user: AuthUser, f: { scope?: "mine" | "unassigned" | "all"; status?: TicketStatus; priority?: TicketPriority; category?: string; q?: string; limit?: number; offset?: number }) {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace("?", `$${args.length}`)); };
    if (user.role === "customer") add("t.user_id = ?", user.id);
    else if (user.role === "staff") {
      if (f.scope === "unassigned") where.push("t.assigned_staff_id is null and t.status = 'open'");
      else add("t.assigned_staff_id = ?", user.id);
    } else {
      if (f.scope === "unassigned") where.push("t.assigned_staff_id is null and t.status = 'open'");
      else if (f.scope === "mine") add("t.assigned_staff_id = ?", user.id);
    }
    if (f.status) add("t.status = ?", f.status);
    if (f.priority) add("t.priority = ?", f.priority);
    if (f.category) add("t.category = ?", f.category);
    // Subject, the customer's description (inquiry), the summaries and the reference, on top of the visibility rules above.
    if (f.q) add("concat_ws(' ', t.subject, t.summary, t.inquiry, t.ai_summary, t.id) ilike ?", containsPattern(f.q));
    const w = where.length ? `where ${where.join(" and ")}` : "";
    const total = Number((await this.pool.query<{ n: string }>(`select count(*) n from escalation_tickets t ${w}`, args)).rows[0]!.n);
    args.push(Math.min(f.limit ?? 50, 200), f.offset ?? 0);
    const { rows } = await this.pool.query<TicketRow>(`${SELECT} ${w} order by case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, t.created_at desc limit $${args.length - 1} offset $${args.length}`, args);
    const limited = user.role === "staff" && f.scope === "unassigned";
    return { total, tickets: rows.map((t) => this.summary(t, user.role === "customer" ? "customer" : user.role === "admin" ? "admin" : limited ? "staff_limited" : "assigned")) };
  }

  async detail(id: string, actor: Actor): Promise<TicketDetail> {
    const { t, level } = await this.visible(id, actor);
    const internal = level === "admin" || level === "assigned";
    const [msgs, notes, hist, assigns, transcript] = await Promise.all([
      level === "staff_limited" ? { rows: [] } : this.pool.query("select m.id, m.author_kind, m.body, m.created_at, u.display_name from ticket_messages m left join users u on u.id = m.author_user_id where m.ticket_id = $1 order by m.id", [id]),
      internal ? this.pool.query("select n.id, n.body, n.created_at, u.display_name from ticket_notes n join users u on u.id = n.author_user_id where n.ticket_id = $1 order by n.id", [id]) : { rows: [] },
      level === "staff_limited" ? { rows: [] } : this.pool.query("select h.from_status, h.to_status, h.note, h.created_at, u.display_name from ticket_status_history h left join users u on u.id = h.changed_by where h.ticket_id = $1 order by h.id", [id]),
      internal ? this.pool.query("select a.method, a.created_at, s.display_name staff, b.display_name by from ticket_assignments a left join users s on s.id = a.staff_id left join users b on b.id = a.assigned_by where a.ticket_id = $1 order by a.id", [id]) : { rows: [] },
      internal ? this.pool.query("select role, author, mode, content, created_at from messages where session_id = $1 order by id", [t.session_id]) : { rows: [] },
    ]);
    const base = this.summary(t, level);
    return {
      ...base,
      description: level === "staff_limited" ? null : t.inquiry ?? t.summary,
      sessionId: level === "staff_limited" ? "" : t.session_id,
      resolution: level === "staff_limited" ? null : t.resolution,
      resolvedAt: t.resolved_at?.toISOString() ?? null, firstResponseAt: t.first_response_at?.toISOString() ?? null,
      messages: msgs.rows.map((m) => ({ id: Number(m.id), authorKind: m.author_kind, authorName: m.display_name ?? null, body: m.body, createdAt: m.created_at.toISOString() })),
      history: hist.rows.map((h) => ({ from: h.from_status, to: h.to_status, by: h.display_name ?? null, note: h.note, at: h.created_at.toISOString() })),
      ...(internal ? {
        notes: notes.rows.map((n) => ({ id: Number(n.id), authorName: n.display_name, body: n.body, createdAt: n.created_at.toISOString() })),
        assignments: assigns.rows.map((a) => ({ staff: a.staff ?? null, by: a.by ?? null, method: a.method, at: a.created_at.toISOString() })),
        transcript: transcript.rows.map((m) => ({ role: m.role, author: m.author, mode: m.mode, content: m.content, at: m.created_at.toISOString() })),
      } : {}),
      allowedTransitions: level === "customer" || level === "staff_limited" ? [] : [...TICKET_TRANSITIONS[t.status]],
    };
  }

  // ---- shared transactional helper ---------------------------------------------------------------------------------------------
  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const r = await fn(c);
      await c.query("commit");
      return r;
    } catch (err) {
      await c.query("rollback");
      throw err;
    } finally {
      c.release();
    }
  }

  private async history(c: Db, id: string, from: string | null, to: string, by: string | null, note?: string | null) {
    await c.query("insert into ticket_status_history (ticket_id, from_status, to_status, changed_by, note) values ($1,$2,$3,$4,$5)", [id, from, to, by, note ?? null]);
  }

  private async setMode(c: Db, sessionId: string, mode: HandoverMode) {
    await c.query("update sessions set handover_mode = $2 where id = $1", [sessionId, mode]);
  }

  private async notifyCustomer(t: TicketRow, kind: string, title: string, body?: string, c: Db = this.pool) {
    if (t.user_id) await this.notifications.notify(t.user_id, kind, title, body, t.id, c);
  }

  private audited(c: Db, user: AuthUser, action: string, id: string, prev?: unknown, next?: unknown) {
    return this.audit.log({ actor: "user", actorUserId: user.id, actorRole: user.role, action, entityType: "ticket", entityId: id, previousValue: prev, newValue: next }, c);
  }

  // ---- claiming and assignment --------------------------------------------------------------------------------------------------
  /**
   * One conditional UPDATE decides the winner: only a ticket that is still open and unassigned matches, so two staff members who
   * click at the same instant cannot both succeed. The loser gets 409.
   */
  async claim(id: string, user: AuthUser): Promise<TicketDetail> {
    await this.tx(async (c) => {
      const { rows } = await c.query<{ session_id: string; user_id: string | null }>(
        "update escalation_tickets set assigned_staff_id = $2, assigned_at = now(), status = 'assigned', updated_at = now() where id = $1 and assigned_staff_id is null and status = 'open' returning session_id, user_id", [id, user.id],
      );
      if (!rows[0]) {
        const exists = await c.query("select 1 from escalation_tickets where id = $1", [id]);
        if (!exists.rows[0]) throw new NotFoundException("Ticket not found.");
        throw new ConflictException("This ticket was already claimed.");
      }
      await c.query("insert into ticket_assignments (ticket_id, staff_id, assigned_by, method) values ($1,$2,$2,'self')", [id, user.id]);
      await this.history(c, id, "open", "assigned", user.id, "claimed");
      await this.setMode(c, rows[0].session_id, "HUMAN_ACTIVE");
      await this.audited(c, user, "ticket.claimed", id, { status: "open" }, { status: "assigned", staffId: user.id });
      if (rows[0].user_id) await this.notifications.notify(rows[0].user_id, "ticket.assigned", "A support specialist is on your ticket", `${user.displayName} will reply here.`, id, c);
    });
    return this.detail(id, { kind: "user", user });
  }

  /** Admin: assign, reassign, or (staffId null) return a ticket to the queue. */
  async assign(id: string, staffId: string | null, admin: AuthUser, method: "manual" | "reassign" | "unassign" = "manual"): Promise<TicketDetail> {
    await this.tx(async (c) => {
      const t = await this.load(id, c, true);
      if (t.status === "closed" || t.status === "resolved") throw new ConflictException("A resolved or closed ticket cannot be assigned.");
      let to = t.status;
      if (staffId) {
        const staff = await c.query("select 1 from users where id = $1 and role = 'staff' and status = 'active'", [staffId]);
        if (!staff.rows[0]) throw new BadRequestException("That user is not an active staff member.");
        if (t.status === "open") to = "assigned";
      } else to = "open";
      const m = !staffId ? "unassign" : t.assigned_staff_id ? "reassign" : method;
      await c.query("update escalation_tickets set assigned_staff_id = $2, assigned_at = case when $2::uuid is null then null else now() end, status = $3, updated_at = now() where id = $1", [id, staffId, to]);
      await c.query("insert into ticket_assignments (ticket_id, staff_id, assigned_by, method) values ($1,$2,$3,$4)", [id, staffId, admin.id, m]);
      if (to !== t.status) await this.history(c, id, t.status, to, admin.id, m);
      await this.setMode(c, t.session_id, staffId ? "HUMAN_ACTIVE" : "WAITING_FOR_STAFF");
      await this.audited(c, admin, `ticket.${m === "unassign" ? "unassigned" : m === "reassign" ? "reassigned" : "assigned"}`, id, { staffId: t.assigned_staff_id }, { staffId });
      if (staffId) await this.notifications.notify(staffId, "ticket.assigned", "A ticket was assigned to you", t.subject ?? t.summary.slice(0, 80), id, c);
      if (staffId && t.user_id) await this.notifications.notify(t.user_id, "ticket.assigned", "A support specialist is on your ticket", undefined, id, c);
    });
    return this.detail(id, { kind: "user", user: admin });
  }

  // ---- automatic assignment ---------------------------------------------------------------------------------------------------------
  async assignmentMode(): Promise<AssignmentMode> {
    const { rows } = await this.pool.query<{ value: AssignmentMode }>("select value from app_settings where key = 'assignment_mode'");
    return rows[0]?.value ?? "manual";
  }

  async setAssignmentMode(mode: AssignmentMode, admin: AuthUser): Promise<void> {
    await this.tx(async (c) => {
      const prev = await this.assignmentMode();
      await c.query("insert into app_settings (key, value, updated_by) values ('assignment_mode', $1::jsonb, $2) on conflict (key) do update set value = $1::jsonb, updated_by = $2, updated_at = now()", [JSON.stringify(mode), admin.id]);
      await this.audited(c, admin, "settings.assignment_mode", "assignment_mode", prev, mode);
    });
  }

  /** Round-robin: next eligible staff member after the one who got the previous automatic ticket. Workload: fewest active tickets. */
  async autoAssign(id: string): Promise<string | null> {
    const mode = await this.assignmentMode();
    if (mode === "manual") return null;
    return this.tx(async (c) => {
      const t = await this.load(id, c, true);
      if (t.assigned_staff_id || t.status !== "open") return null;
      const { rows: cands } = await c.query<{ id: string; active: string }>(
        `select u.id, (select count(*) from escalation_tickets x where x.assigned_staff_id = u.id and x.status = any($1)) as active
         from users u join staff_profiles p on p.user_id = u.id where u.role = 'staff' and u.status = 'active' and p.available
           and (select count(*) from escalation_tickets x where x.assigned_staff_id = u.id and x.status = any($1)) < p.max_active_tickets order by u.id`, [ACTIVE],
      );
      if (!cands.length) return null; // nobody eligible: it stays in the queue for manual or self assignment
      let pick = cands[0]!;
      if (mode === "workload") pick = [...cands].sort((a, b) => Number(a.active) - Number(b.active) || a.id.localeCompare(b.id))[0]!;
      else {
        const last = (await c.query<{ staff_id: string }>("select staff_id from ticket_assignments where method = 'round_robin' and staff_id is not null order by id desc limit 1")).rows[0]?.staff_id;
        pick = cands.find((x) => last && x.id > last) ?? cands[0]!;
      }
      await c.query("update escalation_tickets set assigned_staff_id = $2, assigned_at = now(), status = 'assigned', updated_at = now() where id = $1", [id, pick.id]);
      await c.query("insert into ticket_assignments (ticket_id, staff_id, assigned_by, method) values ($1,$2,null,$3)", [id, pick.id, mode]);
      await this.history(c, id, "open", "assigned", null, `auto:${mode}`);
      await this.setMode(c, t.session_id, "HUMAN_ACTIVE");
      await this.audit.log({ actor: "system", action: "ticket.auto_assigned", entityType: "ticket", entityId: id, newValue: { staffId: pick.id, mode } }, c);
      await this.notifications.notify(pick.id, "ticket.assigned", "A ticket was assigned to you", t.subject ?? t.summary.slice(0, 80), id, c);
      if (t.user_id) await this.notifications.notify(t.user_id, "ticket.assigned", "A support specialist is on your ticket", undefined, id, c);
      return pick.id;
    });
  }

  /** Called right after the AI creates a ticket: tell the team, then try automatic assignment. Never throws into the agent. */
  async afterEscalation(id: string): Promise<void> {
    try {
      const t = await this.load(id);
      const { rows } = await this.pool.query<{ id: string }>("select u.id from users u left join staff_profiles p on p.user_id = u.id where u.status = 'active' and (u.role = 'admin' or (u.role = 'staff' and coalesce(p.available, true)))");
      for (const r of rows) await this.notifications.notify(r.id, "ticket.new", "New escalated ticket", t.subject ?? t.summary.slice(0, 80), id);
      await this.autoAssign(id);
    } catch {
      /* the ticket exists and sits in the queue; notification/assignment failures must not fail the AI run */
    }
  }

  // ---- conversation ---------------------------------------------------------------------------------------------------------------
  private async insertMirror(c: Db, t: TicketRow, role: "user" | "assistant", author: "customer" | "staff", userId: string | null, content: string, clientMessageId?: string) {
    await c.query("insert into messages (session_id, role, mode, content, author, author_user_id, client_message_id) values ($1,$2,'chat',$3,$4,$5,$6) on conflict (session_id, client_message_id) where client_message_id is not null do nothing", [t.session_id, role, content, author, userId, clientMessageId ?? null]);
  }

  async addMessage(id: string, actor: Actor, body: string, clientMessageId?: string): Promise<{ messageId: number; status: TicketStatus }> {
    const result = await this.tx(async (c) => {
      const t = await this.load(id, c, true);
      const level = this.levelOf(t, actor);
      if (!level || level === "staff_limited") throw new NotFoundException("Ticket not found.");
      if (t.status === "closed") throw new ConflictException("This ticket is closed.");
      const staff = actor.kind === "user" && level !== "customer" ? actor.user : null;
      let status = t.status;
      if (staff) {
        const { rows } = await c.query("insert into ticket_messages (ticket_id, author_kind, author_user_id, body) values ($1,'staff',$2,$3) returning id", [id, staff.id, body]);
        await this.insertMirror(c, t, "assistant", "staff", staff.id, body, clientMessageId);
        if (!t.first_response_at) await c.query("update escalation_tickets set first_response_at = now() where id = $1", [id]);
        if (t.status === "assigned") status = "in_progress";
        await c.query("update escalation_tickets set status = $2, updated_at = now() where id = $1", [id, status]);
        if (status !== t.status) await this.history(c, id, t.status, status, staff.id, "first reply");
        await this.notifyCustomer(t, "ticket.reply", "New reply on your ticket", body.slice(0, 140), c);
        return { messageId: Number(rows[0].id), status, userNotify: t.user_id, kind: "staff" as const, t };
      }
      const uid = actor.kind === "user" ? actor.user.id : null;
      const { rows } = await c.query("insert into ticket_messages (ticket_id, author_kind, author_user_id, body) values ($1,'customer',$2,$3) returning id", [id, uid, body]);
      await this.insertMirror(c, t, "user", "customer", uid, body, clientMessageId);
      if (t.status === "waiting_customer") status = "in_progress";
      else if (t.status === "resolved") status = t.assigned_staff_id ? "in_progress" : "open"; // the customer wrote back: reopen
      if (status !== t.status) {
        await c.query("update escalation_tickets set status = $2, resolved_at = null, updated_at = now() where id = $1", [id, status]);
        await this.history(c, id, t.status, status, uid, "customer replied");
        await this.setMode(c, t.session_id, t.assigned_staff_id ? "HUMAN_ACTIVE" : "WAITING_FOR_STAFF");
      } else await c.query("update escalation_tickets set updated_at = now() where id = $1", [id]);
      if (t.assigned_staff_id) await this.notifications.notify(t.assigned_staff_id, "ticket.customer_reply", "Customer replied", body.slice(0, 140), id, c);
      return { messageId: Number(rows[0].id), status, userNotify: t.user_id, kind: "customer" as const, t };
    });
    if (result.userNotify) this.notifications.emit({ userId: result.userNotify, type: "ticket.message", data: { ticketId: id, from: result.kind } });
    if (result.kind === "customer" && result.t.assigned_staff_id) this.notifications.emit({ userId: result.t.assigned_staff_id, type: "ticket.message", data: { ticketId: id, from: "customer" } });
    return { messageId: result.messageId, status: result.status };
  }

  async addNote(id: string, user: AuthUser, body: string): Promise<void> {
    await this.tx(async (c) => {
      const t = await this.load(id, c);
      const level = this.levelOf(t, { kind: "user", user });
      if (level !== "admin" && level !== "assigned") throw new NotFoundException("Ticket not found.");
      await c.query("insert into ticket_notes (ticket_id, author_user_id, body) values ($1,$2,$3)", [id, user.id, body]);
      await this.audited(c, user, "ticket.note_added", id);
    });
  }

  async changeStatus(id: string, to: TicketStatus, user: AuthUser, note?: string): Promise<TicketDetail> {
    if (to === "resolved") throw new BadRequestException("Use the resolve action and describe the resolution.");
    if (to === "open" || to === "assigned") throw new BadRequestException("Use claim / assign / unassign to change who owns a ticket.");
    await this.tx(async (c) => {
      const t = await this.load(id, c, true);
      const level = this.levelOf(t, { kind: "user", user });
      if (level !== "admin" && level !== "assigned") throw new NotFoundException("Ticket not found.");
      if (!TICKET_TRANSITIONS[t.status].includes(to)) throw new ConflictException(`A ${t.status.replace("_", " ")} ticket cannot move to ${to.replace("_", " ")}.`);
      await c.query("update escalation_tickets set status = $2, resolved_at = null, updated_at = now() where id = $1", [id, to]);
      await this.history(c, id, t.status, to, user.id, note);
      if (t.status === "closed" || t.status === "resolved") await this.setMode(c, t.session_id, "HUMAN_ACTIVE"); // reopened: a human is back on it
      if (to === "closed") await this.setMode(c, t.session_id, "AI_ACTIVE");
      await this.audited(c, user, "ticket.status_changed", id, { status: t.status }, { status: to });
      if (to === "waiting_customer") await this.notifyCustomer(t, "ticket.waiting", "We need a reply from you", note, c);
    });
    return this.detail(id, { kind: "user", user });
  }

  /** Resolving ends the human handover: the conversation goes back to the AI, and the customer is told. */
  async resolve(id: string, user: AuthUser, resolution: string): Promise<TicketDetail> {
    await this.tx(async (c) => {
      const t = await this.load(id, c, true);
      const level = this.levelOf(t, { kind: "user", user });
      if (level !== "admin" && level !== "assigned") throw new NotFoundException("Ticket not found.");
      if (!TICKET_TRANSITIONS[t.status].includes("resolved")) throw new ConflictException("This ticket cannot be resolved from its current status.");
      await c.query("update escalation_tickets set status = 'resolved', resolution = $2, resolved_at = now(), updated_at = now() where id = $1", [id, resolution]);
      await this.history(c, id, t.status, "resolved", user.id, resolution.slice(0, 200));
      const msg = await c.query("insert into ticket_messages (ticket_id, author_kind, author_user_id, body) values ($1,'staff',$2,$3) returning id", [id, user.id, `Resolved: ${resolution}`]);
      void msg;
      await this.insertMirror(c, t, "assistant", "staff", user.id, `Your ticket ${id} was resolved: ${resolution}`);
      await this.setMode(c, t.session_id, "AI_ACTIVE");
      await this.audited(c, user, "ticket.resolved", id, { status: t.status }, { status: "resolved" });
      await this.notifyCustomer(t, "ticket.resolved", "Your ticket was resolved", resolution.slice(0, 140), c);
    });
    return this.detail(id, { kind: "user", user });
  }

  async setPriority(id: string, user: AuthUser, priority: TicketPriority): Promise<void> {
    await this.tx(async (c) => {
      const t = await this.load(id, c, true);
      const level = this.levelOf(t, { kind: "user", user });
      if (level !== "admin" && level !== "assigned") throw new NotFoundException("Ticket not found.");
      await c.query("update escalation_tickets set priority = $2, updated_at = now() where id = $1", [id, priority]);
      await this.audited(c, user, "ticket.priority_changed", id, { priority: t.priority }, { priority });
    });
  }

  /** The customer gives up on human help (or the ticket is no longer needed): close it and give the conversation back to the AI. */
  async withdraw(id: string, actor: Actor): Promise<void> {
    await this.tx(async (c) => {
      const t = await this.load(id, c, true);
      if (this.levelOf(t, actor) !== "customer") throw new NotFoundException("Ticket not found.");
      if (t.status === "closed") return;
      await c.query("update escalation_tickets set status = 'closed', resolved_at = coalesce(resolved_at, now()), updated_at = now() where id = $1", [id]);
      await this.history(c, id, t.status, "closed", actor.kind === "user" ? actor.user.id : null, "withdrawn by customer");
      await this.setMode(c, t.session_id, "AI_ACTIVE");
      if (t.assigned_staff_id) await this.notifications.notify(t.assigned_staff_id, "ticket.closed", "Customer withdrew a ticket", t.subject ?? undefined, id, c);
    });
  }

  /** Customer-created ticket (no AI conversation first). It gets its own conversation so staff and customer have a thread. */
  async createManual(user: AuthUser, input: { subject: string; description: string; category: string; priority: TicketPriority }): Promise<TicketDetail> {
    const id = await this.tx(async (c) => {
      const sid = `ses_${randomUUID()}`;
      await c.query("insert into sessions (id, expires_at, user_id, handover_mode, title) values ($1, now() + interval '365 days', $2, 'WAITING_FOR_STAFF', $3)", [sid, user.id, input.subject]);
      const { rows } = await c.query<{ id: string }>(
        `insert into escalation_tickets (session_id, user_id, customer_id, category, priority, reason, summary, inquiry, subject, ai_summary, source, idempotency_key)
         values ($1,$2,$3,$4,$5,'CUSTOMER_REQUESTED',$6,$7,$6,null,'manual',$8) returning id`, [sid, user.id, user.customerId, input.category, input.priority, input.subject, input.description, `manual:${randomUUID()}`],
      );
      await c.query("insert into ticket_messages (ticket_id, author_kind, author_user_id, body) values ($1,'customer',$2,$3)", [rows[0]!.id, user.id, input.description]);
      await this.history(c, rows[0]!.id, null, "open", user.id, "created by customer");
      await this.audit.log({ actor: "user", actorUserId: user.id, actorRole: user.role, action: "ticket.created", entityType: "ticket", entityId: rows[0]!.id, newValue: { source: "manual" } }, c);
      return rows[0]!.id;
    });
    await this.afterEscalation(id);
    return this.detail(id, { kind: "user", user });
  }

  // ---- handover (used by chat, voice and the agent) ---------------------------------------------------------------------------------
  async handoverMode(sessionId: string): Promise<HandoverMode> {
    const { rows } = await this.pool.query<{ handover_mode: HandoverMode }>("select handover_mode from sessions where id = $1", [sessionId]);
    return rows[0]?.handover_mode ?? "AI_ACTIVE";
  }

  /** The ticket currently holding a conversation (if any) for a session. */
  async activeTicketFor(sessionId: string): Promise<TicketRow | null> {
    const { rows } = await this.pool.query<TicketRow>(`${SELECT} where t.session_id = $1 and t.status <> 'closed' and t.status <> 'resolved' order by t.created_at desc limit 1`, [sessionId]);
    return rows[0] ?? null;
  }

  /**
   * A customer message while humans own the conversation: it goes to the ticket thread, never to the AI. If no open ticket exists
   * (stale mode) the conversation is returned to the AI and null tells the caller to carry on normally.
   */
  async routeCustomerMessage(sessionId: string, text: string, clientMessageId: string): Promise<{ handover: true; mode: HandoverMode; ticketId: string; messageId: number } | null> {
    const mode = await this.handoverMode(sessionId);
    if (mode === "AI_ACTIVE") return null;
    const t = await this.activeTicketFor(sessionId);
    if (!t) {
      await this.pool.query("update sessions set handover_mode = 'AI_ACTIVE' where id = $1", [sessionId]);
      return null;
    }
    const r = await this.addMessage(t.id, { kind: "session", sessionId }, text, clientMessageId);
    return { handover: true, mode: await this.handoverMode(sessionId), ticketId: t.id, messageId: r.messageId };
  }

  async handoverView(sessionId: string) {
    const mode = await this.handoverMode(sessionId);
    const t = mode === "AI_ACTIVE" ? null : await this.activeTicketFor(sessionId);
    return { mode, ticket: t ? { id: t.id, status: t.status, subject: t.subject ?? t.summary.slice(0, 80), assignedStaff: t.staff_name } : null };
  }

  // ---- dashboards -----------------------------------------------------------------------------------------------------------------
  async staffStats(user: AuthUser) {
    const { rows } = await this.pool.query(
      `select count(*) filter (where status = any($2)) active, count(*) filter (where status in ('resolved','closed')) resolved,
         coalesce(avg(extract(epoch from (resolved_at - created_at)) / 60) filter (where resolved_at is not null), 0) avg_resolution_min,
         coalesce(avg(extract(epoch from (first_response_at - created_at)) / 60) filter (where first_response_at is not null), 0) avg_first_response_min
       from escalation_tickets where assigned_staff_id = $1`, [user.id, ACTIVE],
    );
    const unassigned = Number((await this.pool.query("select count(*) n from escalation_tickets where status = 'open' and assigned_staff_id is null")).rows[0].n);
    const r = rows[0];
    return { active: Number(r.active), resolved: Number(r.resolved), avgResolutionMinutes: Math.round(Number(r.avg_resolution_min)), avgFirstResponseMinutes: Math.round(Number(r.avg_first_response_min)), unassignedQueue: unassigned };
  }
}
