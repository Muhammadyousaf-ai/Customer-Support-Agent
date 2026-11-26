import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../app.module.js";
import { IngestionService } from "../ingestion/ingestion.service.js";

const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
const report = await app.get(IngestionService).ingestDirectory();
console.log(`embedding model: ${report.embeddingModel} (${report.embeddingTokens} tokens)`);
for (const r of report.results) console.log(`${r.status.padEnd(18)} ${r.file}${r.chunks ? ` (${r.chunks} chunks)` : ""}${r.error ? `  ${r.error}` : ""}`);
await app.close();
process.exit(report.results.some((r) => r.status === "failed") ? 1 : 0);
