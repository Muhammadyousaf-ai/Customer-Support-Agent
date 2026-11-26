import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type pg from "pg";
import type { Role } from "../authorization/permissions.js";
import { toPublicUser, type PublicUser, type UserRow, type UserStatus } from "../auth/auth.types.js";
import { PG_POOL } from "../database/tokens.js";

export interface NewUser { email: string; passwordHash: string | null; role: Role; status: UserStatus; displayName: string; customerId?: string | null; createdBy?: string | null; emailVerified?: boolean }

/** All SQL about accounts. Passwords/hashes never leave this layer except to the auth service. */
@Injectable()
export class UsersService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async findByEmail(email: string): Promise<UserRow | null> {
    const { rows } = await this.pool.query<UserRow>("select * from users where lower(email) = lower($1)", [email.trim()]);
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<UserRow | null> {
    const { rows } = await this.pool.query<UserRow>("select * from users where id = $1", [id]);
    return rows[0] ?? null;
  }

  async require(id: string): Promise<UserRow> {
    const u = await this.findById(id);
    if (!u) throw new NotFoundException("User not found.");
    return u;
  }

  async create(n: NewUser, db: Pick<pg.Pool, "query"> = this.pool): Promise<UserRow> {
    try {
      const { rows } = await db.query<UserRow>(
        `insert into users (email, password_hash, role, status, display_name, customer_id, created_by, email_verified_at)
         values ($1,$2,$3,$4,$5,$6,$7, case when $8 then now() end) returning *`,
        [n.email.trim(), n.passwordHash, n.role, n.status, n.displayName.trim(), n.customerId ?? null, n.createdBy ?? null, n.emailVerified ?? false],
      );
      if (n.role === "staff") await db.query("insert into staff_profiles (user_id) values ($1) on conflict do nothing", [rows[0]!.id]);
      return rows[0]!;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new ConflictException("An account with this email already exists.");
      throw err;
    }
  }

  async list(f: { role?: Role; status?: UserStatus; q?: string; limit?: number; offset?: number }): Promise<{ users: PublicUser[]; total: number }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.role) { args.push(f.role); where.push(`role = $${args.length}`); }
    if (f.status) { args.push(f.status); where.push(`status = $${args.length}`); }
    if (f.q) { args.push(`%${f.q.toLowerCase()}%`); where.push(`(lower(email) like $${args.length} or lower(display_name) like $${args.length})`); }
    const w = where.length ? `where ${where.join(" and ")}` : "";
    const total = Number((await this.pool.query<{ n: string }>(`select count(*) n from users ${w}`, args)).rows[0]!.n);
    args.push(Math.min(f.limit ?? 50, 200), f.offset ?? 0);
    const { rows } = await this.pool.query<UserRow>(`select * from users ${w} order by created_at desc limit $${args.length - 1} offset $${args.length}`, args);
    return { users: rows.map(toPublicUser), total };
  }

  async setStatus(id: string, status: UserStatus): Promise<UserRow> {
    const { rows } = await this.pool.query<UserRow>("update users set status = $2, updated_at = now() where id = $1 returning *", [id, status]);
    if (!rows[0]) throw new NotFoundException("User not found.");
    return rows[0];
  }

  async staffList() {
    const { rows } = await this.pool.query(
      `select u.id, u.email, u.display_name, u.status, p.available, p.max_active_tickets,
         (select count(*) from escalation_tickets t where t.assigned_staff_id = u.id and t.status in ('assigned','in_progress','waiting_customer','pending_review')) as active_tickets,
         (select count(*) from escalation_tickets t where t.assigned_staff_id = u.id and t.status in ('resolved','closed')) as resolved_tickets
       from users u left join staff_profiles p on p.user_id = u.id where u.role = 'staff' order by u.display_name`,
    );
    return rows.map((r) => ({ id: r.id as string, email: r.email as string, displayName: r.display_name as string, status: r.status as UserStatus, available: r.available ?? true, maxActiveTickets: r.max_active_tickets ?? 10, activeTickets: Number(r.active_tickets), resolvedTickets: Number(r.resolved_tickets) }));
  }

  async setAvailability(userId: string, available: boolean): Promise<void> {
    await this.pool.query("insert into staff_profiles (user_id, available) values ($1,$2) on conflict (user_id) do update set available = $2, updated_at = now()", [userId, available]);
  }
}
