import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV } from "../../config/tokens.js";
import { configureApp } from "../../app.setup.js";
import { pool } from "../../database/pool.js";
import { seedDatabase } from "../../database/seed-data.js";
import { EmbeddingService } from "../../rag/embeddings/embedding.service.js";
import { IngestionService } from "../../rag/ingestion/ingestion.service.js";
import { PasswordService } from "../../auth/password.service.js";
import { UsersService } from "../../users/users.service.js";

Object.assign(process.env, {
  AGENT_LLM: "e2e", EMBEDDINGS_PROVIDER: "local", OPENAI_API_KEY: "", VOICE_PROVIDER: "fake",
  RATE_LIMIT_SESSION_PER_MIN: "1000", RATE_LIMIT_IP_PER_MIN: "100000", AUTH_RATE_LIMIT_PER_MIN: "100000", ADMIN_API_KEY: "test-admin-key-0123456789",
  DAILY_AI_BUDGET_USD: "100", REQUIRE_EMAIL_VERIFICATION: "false", LOGIN_MAX_FAILURES: "3",
});
const { AppModule } = await import("../../app.module.js");

const PASSWORD = "correct-horse-9";
const run = Math.random().toString(36).slice(2, 8);
const mail = (n: string) => `${n}.${run}@phase9.test`;

describe("Phase 9: accounts, RBAC, tickets, knowledge base (real HTTP + PostgreSQL)", () => {
  let app: INestApplication;
  let base: string;
  let users: UsersService;
  let passwords: PasswordService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app, "http://localhost:3000", {});
    await app.init();
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/v1`;
    users = app.get(UsersService);
    passwords = app.get(PasswordService);
    await app.get(IngestionService).ingestDirectory();
  });
  afterAll(async () => {
    // Accounts are not reset by seedDatabase, so remove the ones this run created (the dev database is shared).
    const doomed = "select id from users where email like $1";
    const like = `%.${run}@phase9.test`;
    await pool.query(`update app_settings set updated_by = null where updated_by in (${doomed})`, [like]);
    await pool.query(`update users set created_by = null where created_by in (${doomed})`, [like]);
    await pool.query("delete from users where email like $1", [like]);
    await app.close();
  });
  beforeEach(async () => {
    await seedDatabase(pool);
    await pool.query("delete from kb_documents");
    await pool.query("delete from documents"); // each test starts from the folder's documents only
    await app.get(IngestionService).ingestDirectory();
    await pool.query("update app_settings set value = '\"manual\"'::jsonb where key = 'assignment_mode'");
  });

  const call = async (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) => {
    const { token, json, ...rest } = init;
    const res = await fetch(`${base}${path}`, {
      ...rest, body: json !== undefined ? JSON.stringify(json) : rest.body,
      headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(rest.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  let seq = 0;
  const account = async (role: "admin" | "staff" | "customer") => {
    const email = mail(`${role}${++seq}`);
    const u = await users.create({ email, passwordHash: await passwords.hash(PASSWORD), role, status: "active", displayName: `${role} ${seq}`, emailVerified: true });
    const r = await call("/auth/login", { method: "POST", json: { email, password: PASSWORD } });
    expect(r.status).toBe(200);
    return { id: u.id, email, token: r.body.accessToken as string, refresh: r.body.refreshToken as string };
  };
  const newTicket = async (customer: { token: string }, subject = "Charged twice for my plan") =>
    (await call("/tickets", { method: "POST", token: customer.token, json: { subject, description: "I was billed two times this month.", category: "billing" } })).body as { id: string; sessionId: string };

  // ---- authentication -----------------------------------------------------------------------------------------------------
  describe("authentication", () => {
    it("registers a customer, never an admin, and stores an Argon2id hash", async () => {
      const email = mail("reg");
      const r = await call("/auth/register", { method: "POST", json: { email, password: PASSWORD, displayName: "Reg" } });
      expect(r.status).toBe(201);
      expect(r.body.user.role).toBe("customer");
      const row = (await pool.query("select password_hash, role from users where email = $1", [email])).rows[0];
      expect(row.password_hash).toMatch(/^\$argon2id\$/);
      expect((await call("/auth/register", { method: "POST", json: { email: mail("evil"), password: PASSWORD, displayName: "x", role: "admin" } })).status).toBe(400); // unknown field rejected
      expect((await call("/auth/register", { method: "POST", json: { email, password: PASSWORD, displayName: "Dup" } })).status).toBeGreaterThanOrEqual(400); // duplicate
      expect((await call("/auth/register", { method: "POST", json: { email: mail("weak"), password: "short", displayName: "x" } })).status).toBe(400);
    });

    it("gives the same generic error for a wrong password and an unknown account", async () => {
      const c = await account("customer");
      const wrong = await call("/auth/login", { method: "POST", json: { email: c.email, password: "wrong-password-1" } });
      const unknown = await call("/auth/login", { method: "POST", json: { email: mail("ghost"), password: "wrong-password-1" } });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body.message).toBe(unknown.body.message);
    });

    it("locks the account after repeated failures, even for the right password", async () => {
      const c = await account("customer");
      for (let i = 0; i < 3; i++) await call("/auth/login", { method: "POST", json: { email: c.email, password: "wrong-password-1" } });
      expect((await call("/auth/login", { method: "POST", json: { email: c.email, password: PASSWORD } })).status).toBe(429);
    });

    it("rotates refresh tokens and revokes the whole family when an old one is replayed", async () => {
      const c = await account("customer");
      const r1 = await call("/auth/refresh", { method: "POST", json: { refreshToken: c.refresh } });
      expect(r1.status).toBe(200);
      expect(r1.body.refreshToken).not.toBe(c.refresh);
      expect((await call("/auth/refresh", { method: "POST", json: { refreshToken: c.refresh } })).status).toBe(401); // replay
      expect((await call("/auth/refresh", { method: "POST", json: { refreshToken: r1.body.refreshToken } })).status).toBe(401); // family revoked
      expect((await call("/auth/me", { token: r1.body.accessToken })).status).toBe(401); // its access token died with the session
    });

    it("logout revokes the session immediately", async () => {
      const c = await account("customer");
      expect((await call("/auth/me", { token: c.token })).status).toBe(200);
      await call("/auth/logout", { method: "POST", token: c.token, json: { refreshToken: c.refresh } });
      expect((await call("/auth/me", { token: c.token })).status).toBe(401);
    });

    it("rejects missing, malformed and tampered tokens", async () => {
      const c = await account("customer");
      expect((await call("/auth/me")).status).toBe(401);
      expect((await call("/auth/me", { token: "not.a.jwt" })).status).toBe(401);
      const [h, p, s] = c.token.split(".");
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), role: "admin" })).toString("base64url");
      expect((await call("/auth/me", { token: `${h}.${forged}.${s}` })).status).toBe(401);
    });

    it("staff are invited by an admin, accept once, and cannot self-register", async () => {
      const admin = await account("admin");
      const email = mail("invitee");
      const created = await call("/admin/staff", { method: "POST", token: admin.token, json: { email, displayName: "New Staff" } });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe("invited");
      expect((await call("/auth/login", { method: "POST", json: { email, password: PASSWORD } })).status).toBe(401); // no password yet
      const body = (await pool.query("select body from email_outbox where to_address = $1 and purpose = 'invite'", [email])).rows[0].body as string;
      const token = /token=([\w-]+)/.exec(body)![1]!;
      expect((await call("/auth/accept-invite", { method: "POST", json: { token, password: PASSWORD } })).status).toBe(204);
      const login = await call("/auth/login", { method: "POST", json: { email, password: PASSWORD } });
      expect(login.status).toBe(200);
      expect(login.body.user.role).toBe("staff");
    });

    it("suspension signs the user out immediately and blocks login", async () => {
      const admin = await account("admin");
      const c = await account("customer");
      expect((await call(`/admin/users/${c.id}/suspend`, { method: "POST", token: admin.token })).status).toBe(200);
      expect((await call("/auth/me", { token: c.token })).status).toBe(401);
      expect((await call("/auth/login", { method: "POST", json: { email: c.email, password: PASSWORD } })).status).toBeGreaterThanOrEqual(401);
      expect((await call(`/admin/users/${admin.id}/suspend`, { method: "POST", token: admin.token })).status).toBe(403); // not yourself
      await call(`/admin/users/${c.id}/activate`, { method: "POST", token: admin.token });
      expect((await call("/auth/login", { method: "POST", json: { email: c.email, password: PASSWORD } })).status).toBe(200);
    });
  });

  // ---- RBAC -------------------------------------------------------------------------------------------------------------------
  describe("role-based access control", () => {
    it("enforces the permission matrix on admin endpoints", async () => {
      const [admin, staff, customer] = [await account("admin"), await account("staff"), await account("customer")];
      const endpoints = ["/admin/overview", "/admin/staff", "/admin/customers", "/admin/audit-logs", "/admin/settings", "/admin/kb/documents"];
      for (const path of endpoints) {
        expect((await call(path)).status, `${path} anonymous`).toBe(401);
        expect((await call(path, { token: customer.token })).status, `${path} customer`).toBe(403);
        expect((await call(path, { token: staff.token })).status, `${path} staff`).toBe(403);
        expect((await call(path, { token: admin.token })).status, `${path} admin`).toBe(200);
      }
      expect((await call("/admin/staff", { method: "POST", token: staff.token, json: { email: mail("x"), displayName: "x" } })).status).toBe(403);
      expect((await call("/admin/kb/documents", { method: "POST", token: customer.token, json: { source: "x".repeat(30) } })).status).toBe(403);
    });

    it("a customer sees only their own tickets and a stranger gets 404", async () => {
      const [a, b, staff] = [await account("customer"), await account("customer"), await account("staff")];
      const t = await newTicket(a);
      expect((await call("/tickets", { token: a.token })).body.tickets.map((x: any) => x.id)).toContain(t.id);
      expect((await call("/tickets", { token: b.token })).body.tickets).toEqual([]);
      expect((await call(`/tickets/${t.id}`, { token: b.token })).status).toBe(404);
      expect((await call(`/tickets/${t.id}/messages`, { method: "POST", token: b.token, json: { body: "hi" } })).status).toBe(404);
      expect((await call(`/tickets/${t.id}/claim`, { method: "POST", token: a.token })).status).toBe(403);
      expect((await call(`/tickets/${t.id}`, { token: staff.token })).status).toBe(200);
    });

    it("unassigned tickets show staff no customer identity, and internal notes stay internal", async () => {
      const [customer, s1, s2, admin] = [await account("customer"), await account("staff"), await account("staff"), await account("admin")];
      const t = await newTicket(customer);
      const limited = (await call(`/tickets/${t.id}`, { token: s1.token })).body;
      expect(limited.customer?.email ?? null).toBeNull();
      expect(limited.transcript).toBeUndefined();
      expect(limited.messages ?? []).toEqual([]);
      expect((await call(`/tickets/${t.id}/notes`, { method: "POST", token: s1.token, json: { body: "x" } })).status).toBeGreaterThanOrEqual(403); // must claim first
      expect((await call(`/tickets/${t.id}/claim`, { method: "POST", token: s1.token })).status).toBe(200);
      expect((await call(`/tickets/${t.id}/notes`, { method: "POST", token: s1.token, json: { body: "SECRET internal note" } })).status).toBe(201);
      const asStaff = (await call(`/tickets/${t.id}`, { token: s1.token })).body;
      expect(asStaff.customer.email).toBe(customer.email);
      expect(JSON.stringify(asStaff.notes)).toContain("SECRET internal note");
      expect(JSON.stringify((await call(`/tickets/${t.id}`, { token: customer.token })).body)).not.toContain("SECRET");
      expect((await call(`/tickets/${t.id}`, { token: s2.token })).body.notes).toBeUndefined(); // other staff
      expect(JSON.stringify((await call(`/tickets/${t.id}`, { token: admin.token })).body.notes)).toContain("SECRET");
      expect((await call(`/tickets/${t.id}/messages`, { method: "POST", token: s2.token, json: { body: "hijack" } })).status).toBeGreaterThanOrEqual(403);
    });
  });

  // ---- tickets ----------------------------------------------------------------------------------------------------------------
  describe("tickets", () => {
    it("lets exactly one of several staff claim a ticket", async () => {
      const customer = await account("customer");
      const staff = await Promise.all([account("staff"), account("staff"), account("staff"), account("staff")]);
      const t = await newTicket(customer);
      const results = await Promise.all(staff.map((s) => call(`/tickets/${t.id}/claim`, { method: "POST", token: s.token })));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(3);
      const winner = staff[results.findIndex((r) => r.status === 200)]!;
      const row = (await pool.query("select assigned_staff_id, status from escalation_tickets where id = $1", [t.id])).rows[0];
      expect(row.assigned_staff_id).toBe(winner.id);
      expect(row.status).toBe("assigned");
      expect((await pool.query("select count(*)::int n from ticket_assignments where ticket_id = $1", [t.id])).rows[0].n).toBe(1);
    });

    it("walks the lifecycle, rejects illegal transitions, and records history", async () => {
      const [customer, staff] = [await account("customer"), await account("staff")];
      const t = await newTicket(customer);
      const step = (status: string, token = staff.token) => call(`/tickets/${t.id}/status`, { method: "POST", token, json: { status } });
      expect((await step("in_progress")).status).toBeGreaterThanOrEqual(400); // not claimed yet
      await call(`/tickets/${t.id}/claim`, { method: "POST", token: staff.token });
      expect((await step("closed")).status).toBeGreaterThanOrEqual(400); // assigned -> closed is not allowed
      expect((await step("in_progress")).status).toBe(200);
      expect((await step("waiting_customer")).status).toBe(200);
      expect((await call(`/tickets/${t.id}/resolve`, { method: "POST", token: staff.token, json: { resolution: "Refunded the duplicate charge." } })).status).toBe(200);
      const detail = (await call(`/tickets/${t.id}`, { token: staff.token })).body;
      expect(detail.status).toBe("resolved");
      expect(detail.resolution).toContain("Refunded");
      expect(detail.history.map((h: any) => h.to)).toEqual(["open", "assigned", "in_progress", "waiting_customer", "resolved"]);
      expect((await step("in_progress")).status).toBe(200); // reopen
    });

    it("exchanges messages between customer and staff and notifies each side", async () => {
      const [customer, staff] = [await account("customer"), await account("staff")];
      const t = await newTicket(customer);
      await call(`/tickets/${t.id}/claim`, { method: "POST", token: staff.token });
      expect((await call(`/tickets/${t.id}/messages`, { method: "POST", token: staff.token, json: { body: "We are on it." } })).status).toBe(201);
      expect((await call(`/tickets/${t.id}/messages`, { method: "POST", token: customer.token, json: { body: "Thanks!" } })).status).toBe(201);
      const seen = (await call(`/tickets/${t.id}`, { token: customer.token })).body;
      expect(seen.messages.map((m: any) => m.body)).toEqual(expect.arrayContaining(["We are on it.", "Thanks!"]));
      expect((await call("/me/notifications", { token: customer.token })).body.items?.length ?? (await call("/me/notifications", { token: customer.token })).body.length).toBeGreaterThan(0);
      expect((await pool.query("select first_response_at from escalation_tickets where id = $1", [t.id])).rows[0].first_response_at).not.toBeNull();
    });

    it("assigns by round robin and by workload when configured", async () => {
      const admin = await account("admin");
      const staff = await Promise.all([account("staff"), account("staff")]);
      await pool.query("update staff_profiles set available = false where user_id <> all($1::uuid[])", [staff.map((s) => s.id)]);
      await pool.query("update staff_profiles set available = true where user_id = any($1::uuid[])", [staff.map((s) => s.id)]);
      expect((await call("/admin/settings/assignment-mode", { method: "PUT", token: admin.token, json: { mode: "round_robin" } })).status).toBe(200);
      const customer = await account("customer");
      const a = await newTicket(customer, "First ticket here");
      const b = await newTicket(customer, "Second ticket here");
      const owners = (await pool.query("select assigned_staff_id from escalation_tickets where id::text = any($1::text[])", [[a.id, b.id]])).rows.map((r) => r.assigned_staff_id);
      expect(new Set(owners).size).toBe(2); // spread across both
      await call("/admin/settings/assignment-mode", { method: "PUT", token: admin.token, json: { mode: "workload" } });
      const c = await newTicket(customer, "Third ticket here");
      expect((await pool.query("select assigned_staff_id from escalation_tickets where id = $1", [c.id])).rows[0].assigned_staff_id).not.toBeNull();
    });

    it("lets an admin reassign and records who did it", async () => {
      const [admin, s1, s2, customer] = [await account("admin"), await account("staff"), await account("staff"), await account("customer")];
      const t = await newTicket(customer);
      await call(`/tickets/${t.id}/claim`, { method: "POST", token: s1.token });
      expect((await call(`/tickets/${t.id}/assign`, { method: "POST", token: s1.token, json: { staffId: s2.id } })).status).toBe(403); // staff cannot reassign
      expect((await call(`/tickets/${t.id}/assign`, { method: "POST", token: admin.token, json: { staffId: s2.id } })).status).toBe(200);
      expect((await pool.query("select assigned_staff_id from escalation_tickets where id = $1", [t.id])).rows[0].assigned_staff_id).toBe(s2.id);
      expect((await pool.query("select count(*)::int n from audit_logs where entity_id = $1 and actor_user_id = $2", [t.id, admin.id])).rows[0].n).toBeGreaterThan(0);
    });
  });

  // ---- handover ---------------------------------------------------------------------------------------------------------------
  describe("handover to a human", () => {
    it("stops AI replies while a human owns the conversation and resumes afterwards", async () => {
      const [customer, staff] = [await account("customer"), await account("staff")];
      const t = await newTicket(customer);
      const tok = (await call(`/me/sessions/${t.sessionId}/token`, { method: "POST", token: customer.token })).body;
      expect(tok.sessionToken).toBeTruthy();
      const runs = async () => (await pool.query("select count(*)::int n from agent_runs where session_id = $1", [t.sessionId])).rows[0].n as number;
      expect((await call(`/sessions/${t.sessionId}/handover`, { token: tok.sessionToken })).body.mode).toBe("WAITING_FOR_STAFF");
      const waiting = await call(`/sessions/${t.sessionId}/messages`, { method: "POST", token: tok.sessionToken, json: { message: "Any update?", clientMessageId: `m-${run}-1` } });
      expect(waiting.status).toBeLessThan(300);
      expect(await runs()).toBe(0); // the AI did not run
      await call(`/tickets/${t.id}/claim`, { method: "POST", token: staff.token });
      expect((await call(`/sessions/${t.sessionId}/handover`, { token: tok.sessionToken })).body.mode).toBe("HUMAN_ACTIVE");
      await call(`/sessions/${t.sessionId}/messages`, { method: "POST", token: tok.sessionToken, json: { message: "Hello human", clientMessageId: `m-${run}-2` } });
      expect(await runs()).toBe(0);
      const thread = (await call(`/tickets/${t.id}`, { token: staff.token })).body.messages.map((m: any) => m.body);
      expect(thread).toContain("Hello human"); // routed to the staff member, not the model
      await call(`/tickets/${t.id}/status`, { method: "POST", token: staff.token, json: { status: "in_progress" } });
      await call(`/tickets/${t.id}/resolve`, { method: "POST", token: staff.token, json: { resolution: "Sorted out." } });
      expect((await call(`/sessions/${t.sessionId}/handover`, { token: tok.sessionToken })).body.mode).toBe("AI_ACTIVE");
    });

    it("lets another customer's session token neither read nor post into the ticket", async () => {
      const [a, b] = [await account("customer"), await account("customer")];
      const t = await newTicket(a);
      expect((await call(`/me/sessions/${t.sessionId}/token`, { method: "POST", token: b.token })).status).toBeGreaterThanOrEqual(401);
      expect((await call(`/sessions/${t.sessionId}/ticket`, { token: b.token })).status).toBeGreaterThanOrEqual(401);
    });
  });

  // ---- knowledge base ---------------------------------------------------------------------------------------------------------
  describe("knowledge base management", () => {
    const doc = (title: string, extra = "") =>
      `---\ntitle: ${title}\ncategory: refund\nversion: 1.0\n---\n# ${title}\n\n## Window\n\nRefunds for quokka subscriptions are available within 21 days. ${extra}\n`;
    const searchHits = async (admin: { token: string }, query: string) =>
      ((await call("/admin/kb/test", { method: "POST", token: admin.token, json: { query } })).body.sources ?? []) as Array<{ documentTitle: string; content: string }>;

    it("adopts the existing knowledge base and publishes a new document into retrieval", async () => {
      const admin = await account("admin");
      const list = (await call("/admin/kb/documents", { token: admin.token })).body as any[];
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((d) => d.status === "published" && d.indexStatus === "indexed")).toBe(true);
      const created = await call("/admin/kb/documents", { method: "POST", token: admin.token, json: { source: doc(`Quokka refunds ${run}`) } });
      expect(created.status).toBe(201);
      expect((await call("/admin/kb/documents", { method: "POST", token: admin.token, json: { source: doc(`Quokka refunds ${run}`) } })).status).toBe(409); // duplicate title
      expect((await searchHits(admin, "quokka subscription refund window")).some((c) => c.documentTitle === `Quokka refunds ${run}`)).toBe(false); // a draft is not live
      const pub = await call(`/admin/kb/documents/${created.body.id}/publish`, { method: "POST", token: admin.token, json: {} });
      expect(pub.body.ok).toBe(true);
      expect((await searchHits(admin, "quokka subscription refund window")).some((c) => c.documentTitle === `Quokka refunds ${run}`)).toBe(true);
    });

    it("previews chunks, and rejects invalid documents", async () => {
      const admin = await account("admin");
      const p = await call("/admin/kb/preview", { method: "POST", token: admin.token, json: { source: doc("Preview doc") } });
      expect(p.status).toBe(200);
      expect(p.body.chunks.length).toBeGreaterThan(0);
      expect((await call("/admin/kb/preview", { method: "POST", token: admin.token, json: { source: "no frontmatter at all, just a long enough body of text" } })).status).toBe(400);
    });

    it("keeps the previous version live when indexing fails", async () => {
      const admin = await account("admin");
      const created = await call("/admin/kb/documents", { method: "POST", token: admin.token, json: { source: doc(`Stable policy ${run}`, "Original wording.") } });
      const id = created.body.id as string;
      expect((await call(`/admin/kb/documents/${id}/publish`, { method: "POST", token: admin.token, json: {} })).body.ok).toBe(true);
      await call(`/admin/kb/documents/${id}`, { method: "PUT", token: admin.token, json: { source: doc(`Stable policy ${run}`, "Changed wording marmot.") } });
      const spy = vi.spyOn(app.get(EmbeddingService), "embedDocuments").mockRejectedValueOnce(new Error("embedding provider down"));
      const failed = await call(`/admin/kb/documents/${id}/publish`, { method: "POST", token: admin.token, json: {} });
      spy.mockRestore();
      expect(failed.body.ok).toBe(false);
      const detail = (await call(`/admin/kb/documents/${id}`, { token: admin.token })).body;
      expect(detail.publishedVersion).toBe(1);
      expect(detail.versions.find((v: any) => v.version === 2).indexStatus).toBe("failed");
      const hits = await searchHits(admin, "stable policy quokka refund window");
      expect(hits.some((c) => c.content.includes("Original wording"))).toBe(true);
      expect(hits.some((c) => c.content.includes("marmot"))).toBe(false);
      // retrying once the provider is back succeeds
      expect((await call(`/admin/kb/documents/${id}/publish`, { method: "POST", token: admin.token, json: {} })).body.ok).toBe(true);
    });

    it("keeps version history, restores an old version, and deleting removes the embeddings", async () => {
      const admin = await account("admin");
      const title = `Versioned ${run}`;
      const id = (await call("/admin/kb/documents", { method: "POST", token: admin.token, json: { source: doc(title, "Alpha wording.") } })).body.id as string;
      await call(`/admin/kb/documents/${id}/publish`, { method: "POST", token: admin.token, json: {} });
      await call(`/admin/kb/documents/${id}`, { method: "PUT", token: admin.token, json: { source: doc(title, "Beta wording.") } });
      await call(`/admin/kb/documents/${id}/publish`, { method: "POST", token: admin.token, json: {} });
      let d = (await call(`/admin/kb/documents/${id}`, { token: admin.token })).body;
      expect(d.versions.map((v: any) => [v.version, v.status])).toEqual([[2, "published"], [1, "superseded"]]);
      const restored = await call(`/admin/kb/documents/${id}/versions/1/restore`, { method: "POST", token: admin.token, json: { publish: true } });
      expect(restored.body.ok).toBe(true);
      d = (await call(`/admin/kb/documents/${id}`, { token: admin.token })).body;
      expect(d.publishedVersion).toBe(3);
      expect(d.source).toContain("Alpha wording");
      expect((await pool.query("select count(*)::int n from documents where title = $1", [title])).rows[0].n).toBe(1);
      expect((await call(`/admin/kb/documents/${id}`, { method: "DELETE", token: admin.token })).status).toBe(204);
      expect((await pool.query("select count(*)::int n from documents where title = $1", [title])).rows[0].n).toBe(0);
      expect((await pool.query("select count(*)::int n from document_chunks c left join documents d on d.id = c.document_id where d.id is null")).rows[0].n).toBe(0);
      expect((await call(`/admin/kb/documents/${id}`, { token: admin.token })).status).toBe(404);
    });

    it("uploads a text file and rejects unsupported types and fake PDFs", async () => {
      const admin = await account("admin");
      const send = async (name: string, content: string, fields: Record<string, string> = {}) => {
        const form = new FormData();
        for (const [k, v] of Object.entries(fields)) form.set(k, v);
        form.set("file", new Blob([content]), name);
        const res = await fetch(`${base}/admin/kb/upload`, { method: "POST", headers: { authorization: `Bearer ${admin.token}` }, body: form });
        return { status: res.status, body: (await res.json().catch(() => null)) as any };
      };
      const ok = await send("notes.txt", "Quokka returns are accepted within thirty days of delivery.", { title: `Uploaded ${run}`, category: "refund" });
      expect(ok.status).toBe(201);
      expect(ok.body.versions[0].status).toBe("draft");
      expect((await send("notes.txt", "text without metadata")).status).toBe(400);
      expect((await send("malware.exe", "MZ", { title: "x", category: "refund" })).status).toBe(400);
      expect((await send("fake.pdf", "this is not a pdf", { title: "x", category: "refund" })).status).toBe(400);
    });

    it("records knowledge-base changes in the audit log", async () => {
      const admin = await account("admin");
      const id = (await call("/admin/kb/documents", { method: "POST", token: admin.token, json: { source: doc(`Audited ${run}`) } })).body.id as string;
      await call(`/admin/kb/documents/${id}/publish`, { method: "POST", token: admin.token, json: {} });
      const log = (await call("/admin/audit-logs?action=kb.", { token: admin.token })).body;
      const actions = log.entries.filter((e: any) => e.entityId === id).map((e: any) => e.action);
      expect(actions).toEqual(expect.arrayContaining(["kb.created", "kb.published"]));
      expect(log.entries[0].actorName).toBeTruthy();
    });
  });

  it("the AI assistant requires an account unless anonymous demo sessions are explicitly enabled", async () => {
    const env = app.get(ENV) as { ALLOW_ANONYMOUS_SESSIONS: string };
    const before = env.ALLOW_ANONYMOUS_SESSIONS;
    try {
      env.ALLOW_ANONYMOUS_SESSIONS = "false";
      expect((await call("/sessions", { method: "POST" })).status).toBe(401);
      const customer = await account("customer");
      const owned = await call("/sessions", { method: "POST", token: customer.token });
      expect(owned.status).toBe(201);
      expect((await call("/me/sessions", { token: customer.token })).body.map((s: any) => s.id)).toContain(owned.body.sessionId);
      env.ALLOW_ANONYMOUS_SESSIONS = "true";
      expect((await call("/sessions", { method: "POST" })).status).toBe(201);
    } finally {
      env.ALLOW_ANONYMOUS_SESSIONS = before;
    }
  });
});
