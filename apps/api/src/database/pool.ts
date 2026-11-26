import pg from "pg";
import { loadEnv } from "../config/env.js";

export const pool = new pg.Pool({ connectionString: loadEnv().DATABASE_URL });
