import { pool } from "./pool.js";
import { seedDemoAccounts, DEMO_PASSWORD } from "./seed-accounts.js";
import { seedDatabase } from "./seed-data.js";

await seedDatabase(pool);
console.log("seeded 6 customers, subscriptions, contracts and 7 payments");
if (process.env.NODE_ENV !== "production") {
  await seedDemoAccounts(pool);
  console.log(`demo accounts: admin@example.com, staff1@example.com, staff2@example.com, customer@example.com, sarah@example.com (password ${DEMO_PASSWORD})`);
}
await pool.end();
