import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { configureApp } from "./app.setup.js";
import { loadEnv } from "./config/env.js";
import { logger } from "./observability/logging/logger.js";

// A stray rejection must be visible and must not silently corrupt state; an uncaught exception leaves the process in an
// unknown state, so log it and let the platform restart a fresh one (graceful shutdown handles the signal path).
process.on("unhandledRejection", (reason) => logger.error({ event: "unhandled_rejection", reason: reason instanceof Error ? reason.message : String(reason) }, "unhandled promise rejection"));
process.on("uncaughtException", (err) => {
  logger.fatal({ event: "uncaught_exception", error: err.message }, "uncaught exception; exiting");
  process.exit(1);
});

async function bootstrap() {
  const env = loadEnv(); // refuses to start on a missing/unsafe production configuration
  const app = await NestFactory.create(AppModule, { bodyParser: false }); // configureApp installs a size-limited JSON parser
  configureApp(app, env.WEB_ORIGIN, { maxBodyBytes: env.MAX_BODY_BYTES });
  // All interfaces, on the platform-provided port (containers).
  await app.listen(env.PORT, "0.0.0.0");
  logger.info({ event: "app.started", port: env.PORT, version: env.APP_VERSION, env: env.NODE_ENV }, "listening");
}
await bootstrap();
