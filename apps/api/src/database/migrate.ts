import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const dir = fileURLToPath(new URL("../../db/migrations/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

await pool.query(
  "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
);
const applied = new Set((await pool.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));

for (const file of files) {
  if (applied.has(file)) continue;
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(readFileSync(dir + file, "utf8"));
    await client.query("insert into schema_migrations (name) values ($1)", [file]);
    await client.query("commit");
    console.log(`applied ${file}`);
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
console.log("migrations up to date");
await pool.end();
