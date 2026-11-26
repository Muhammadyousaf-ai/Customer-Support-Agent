import { NestFactory } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { pool } from "../../database/pool.js";

Object.assign(process.env, { AGENT_LLM: "e2e", EMBEDDINGS_PROVIDER: "local", OPENAI_API_KEY: "", VOICE_PROVIDER: "fake" });
const { AppModule } = await import("../../app.module.js");

describe("standalone boot (CLI scripts: rag:ingest, agent:eval, db seed...)", () => {
  it("boots the whole module graph without an HTTP server, and shuts down cleanly", async () => {
    // Regression: the Phase 6 voice gateway assumed an HTTP adapter and crashed every CLI that boots AppModule.
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    expect((await pool.query("select 1 as ok")).rows[0].ok).toBe(1);
    await app.close();
  });
});
