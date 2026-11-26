import { hash, Algorithm } from "@node-rs/argon2";
import { passwordSchema, emailSchema } from "@support-ai/contracts";
import { pool } from "./pool.js";

/**
 * The only way to create an administrator (the API never can). Usage:
 *   ADMIN_EMAIL=you@company.com ADMIN_PASSWORD='...' ADMIN_NAME='Your Name' pnpm --filter api auth:create-admin
 */
const email = emailSchema.safeParse(process.env.ADMIN_EMAIL);
const password = passwordSchema.safeParse(process.env.ADMIN_PASSWORD);
if (!email.success || !password.success) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD (10+ characters, letters and a digit). ADMIN_NAME is optional.");
  process.exit(1);
}
const passwordHash = await hash(password.data, { algorithm: 2 as Algorithm, memoryCost: 19456, timeCost: 2, parallelism: 1 });
const { rows } = await pool.query(
  `insert into users (email, password_hash, role, status, display_name, email_verified_at) values ($1,$2,'admin','active',$3, now())
   on conflict (lower(email)) do update set role = 'admin', password_hash = excluded.password_hash, status = 'active' returning id`,
  [email.data, passwordHash, process.env.ADMIN_NAME?.trim() || "Administrator"],
);
await pool.query("insert into audit_logs (actor, action, entity_type, entity_id) values ('system','admin.created_by_cli','user',$1)", [rows[0].id]);
console.log(`Administrator ready: ${email.data}`);
await pool.end();
