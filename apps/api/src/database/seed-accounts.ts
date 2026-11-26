import { hash, Algorithm } from "@node-rs/argon2";
import type pg from "pg";

export const DEMO_PASSWORD = "demo-password-1";
export const DEMO_ACCOUNTS = [
  { email: "admin@example.com", name: "Alex Admin", role: "admin" },
  { email: "staff1@example.com", name: "Sam Support", role: "staff" },
  { email: "staff2@example.com", name: "Riley Support", role: "staff" },
  { email: "customer@example.com", name: "Casey Customer", role: "customer" },
  { email: "sarah@example.com", name: "Sarah Wilson", role: "customer", customerId: "CUST-002" },
] as const;

/** Development convenience only: well-known passwords. Refused in production. Idempotent. */
export async function seedDemoAccounts(db: pg.Pool): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("Demo accounts must never be created in production.");
  const passwordHash = await hash(DEMO_PASSWORD, { algorithm: 2 as Algorithm, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  for (const a of DEMO_ACCOUNTS) {
    const { rows } = await db.query<{ id: string }>(
      `insert into users (email, password_hash, role, status, display_name, customer_id, email_verified_at)
       values ($1,$2,$3,'active',$4,$5, now()) on conflict (lower(email)) do update set password_hash = excluded.password_hash, status = 'active', customer_id = coalesce(excluded.customer_id, users.customer_id), failed_logins = 0, locked_until = null returning id`,
      [a.email, passwordHash, a.role, a.name, "customerId" in a ? a.customerId : null],
    );
    if (a.role === "staff") await db.query("insert into staff_profiles (user_id) values ($1) on conflict do nothing", [rows[0]!.id]);
  }
}
