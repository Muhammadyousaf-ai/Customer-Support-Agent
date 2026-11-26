import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureApp } from "../../app.setup.js";
import { pool } from "../../database/pool.js";
import { PasswordService } from "../../auth/password.service.js";
import { UsersService } from "../../users/users.service.js";

Object.assign(process.env, {
  AGENT_LLM: "e2e", EMBEDDINGS_PROVIDER: "local", OPENAI_API_KEY: "", VOICE_PROVIDER: "fake",
  RATE_LIMIT_SESSION_PER_MIN: "1000", RATE_LIMIT_IP_PER_MIN: "100000", AUTH_RATE_LIMIT_PER_MIN: "100000", ADMIN_API_KEY: "test-admin-key-0123456789",
  REQUIRE_EMAIL_VERIFICATION: "false",
});
const { AppModule } = await import("../../app.module.js");

const PASSWORD = "correct-horse-9";
const run = Math.random().toString(36).slice(2, 8);

/** `?q=` on conversations and tickets: matches title/subject, message or description text and the reference, never past the caller's own visibility. */
describe("search (real HTTP + PostgreSQL)", () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app, "http://localhost:3000", {});
    await app.init();
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/v1`;
    await pool.query("update app_settings set value = '\"manual\"'::jsonb where key = 'assignment_mode'"); // tickets stay unassigned
  });
  // Rows are unique per run (the test database is reseeded by the other suites), so there is nothing to clean up.
  afterAll(() => app.close());

  const call = async (path: string, token: string, json?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: json ? "POST" : "GET", body: json ? JSON.stringify(json) : undefined,
      headers: { authorization: `Bearer ${token}`, ...(json ? { "content-type": "application/json" } : {}) },
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  let seq = 0;
  const account = async (role: "admin" | "staff" | "customer") => {
    const email = `${role}${++seq}.${run}@search.test`;
    await app.get(UsersService).create({ email, passwordHash: await app.get(PasswordService).hash(PASSWORD), role, status: "active", displayName: `${role} ${seq}`, emailVerified: true });
    const r = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
    return ((await r.json()) as { accessToken: string }).accessToken;
  };
  const ticket = async (token: string) =>
    (await call("/tickets", token, { subject: `Router ${run} keeps rebooting`, description: `Blinking light ${run} since Monday`, category: "technical" })).body as { id: string; sessionId: string };

  it("filters conversations by title and message text, scoped to the signed-in owner, with % and _ taken literally", async () => {
    const [alice, bob] = [await account("customer"), await account("customer")];
    const a = await ticket(alice);
    const b = await ticket(bob);
    await pool.query("insert into messages (session_id, role, mode, content) values ($1, 'user', 'chat', $2)", [a.sessionId, `I am 100% sure ${run}`]);

    const ids = async (token: string, q: string) => ((await call(`/me/sessions?q=${encodeURIComponent(q)}`, token)).body as Array<{ id: string }>).map((s) => s.id);
    expect(await ids(alice, `Router ${run}`)).toEqual([a.sessionId]); // title; Bob's identical title is not visible
    expect(await ids(bob, `rOuTeR ${run}`)).toEqual([b.sessionId]);
    expect(await ids(alice, `100% sure ${run}`)).toEqual([a.sessionId]); // message content
    expect(await ids(bob, `100% sure ${run}`)).toEqual([]);
    expect(await ids(alice, `10_% sure ${run}`)).toEqual([]); // _ is not a wildcard
    expect(await ids(alice, "%")).toEqual([]); // % is not a wildcard
    expect((await call(`/me/sessions?q=${"x".repeat(101)}`, alice)).status).toBe(400);
  });

  it("filters tickets by subject, description and reference within each role's visibility", async () => {
    const [alice, bob, staff, admin] = [await account("customer"), await account("customer"), await account("staff"), await account("admin")];
    const a = await ticket(alice);
    const b = await ticket(bob);

    const ids = async (token: string, q: string) => ((await call(`/tickets?q=${encodeURIComponent(q)}`, token)).body as { tickets: Array<{ id: string }> }).tickets.map((t) => t.id).sort();
    expect(await ids(alice, `blinking LIGHT ${run}`)).toEqual([a.id]); // description, and only her own
    expect(await ids(bob, `rebooting`)).toContain(b.id);
    expect(await ids(bob, `rebooting`)).not.toContain(a.id);
    expect(await ids(alice, a.id)).toEqual([a.id]); // reference
    expect(await ids(alice, b.id)).toEqual([]);
    expect(await ids(staff, `Router ${run}`)).toEqual([]); // nothing assigned to this staff member
    expect(await ids(admin, `Router ${run}`)).toEqual([a.id, b.id].sort());
    expect(await ids(admin, `Router_${run}`)).toEqual([]);
  });
});
