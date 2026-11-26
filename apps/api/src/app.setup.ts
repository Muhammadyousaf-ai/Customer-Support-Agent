import { type INestApplication, VersioningType } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { API_VERSION } from "@support-ai/contracts";
import helmet from "helmet";
import { requestLogger } from "./common/request-logger.js";

/** Shared by main.ts and e2e tests so both run the same HTTP pipeline. */
export function configureApp(app: INestApplication, webOrigin: string, o: { maxBodyBytes?: number } = {}): void {
  app.use(requestLogger);
  // Security headers. This is a JSON/SSE API, so the default CSP (no scripts, no framing) is exactly right; CORP is relaxed
  // because the frontend is on another origin and CORS (below) is the real cross-origin gate.
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  (app as NestExpressApplication).useBodyParser?.("json", { limit: o.maxBodyBytes ?? 32_768 });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION });
  app.enableCors({ origin: webOrigin.split(","), credentials: true, allowedHeaders: ["authorization", "content-type", "last-event-id", "x-admin-key"], exposedHeaders: ["retry-after"] });
  app.enableShutdownHooks();
}
