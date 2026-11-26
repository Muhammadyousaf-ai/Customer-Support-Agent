import { prepareTestDatabase } from "../src/database/test-database.js";

export default async function setup() {
  await prepareTestDatabase();
}
