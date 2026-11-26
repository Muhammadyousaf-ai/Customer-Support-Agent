import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Automated tests reseed (truncate) their database, so they must never share the development one.
 * The test database lives on the same server under another name and is created and migrated on demand.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://support:support@localhost:5433/support_ai_test";

export async function prepareTestDatabase(url = TEST_DATABASE_URL): Promise<string> {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(name)) throw new Error(`Refusing to use "${name}" as a test database: its name must end in _test.`);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (!exists.rowCount) await client.query(`create database "${name}"`);
  } finally {
    await client.end();
  }
  const r = spawnSync("pnpm", ["exec", "tsx", "src/database/migrate.ts"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`Migrating the test database failed:\n${r.stderr || r.stdout}`);
  return url;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await prepareTestDatabase();
  console.log(`test database ready: ${new URL(TEST_DATABASE_URL).pathname.slice(1)}`);
}
