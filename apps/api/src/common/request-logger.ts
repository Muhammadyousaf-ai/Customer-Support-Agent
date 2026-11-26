import { Logger } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

const logger = new Logger("HTTP");

/**
 * One line per API request when it ends: method, path, status, duration, and the error body for 4xx/5xx.
 * The query string is dropped because SSE carries the session token there. Success bodies are not logged:
 * they hold customer conversation data.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const started = performance.now();
  let errorBody = "";
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode >= 400) errorBody = JSON.stringify(body).slice(0, 300);
    return json(body);
  };

  let logged = false;
  const log = () => {
    if (logged) return;
    logged = true;
    const ms = Math.round(performance.now() - started);
    const aborted = res.writableFinished ? "" : " (client closed)";
    const line = `${req.method.padEnd(6)} ${req.originalUrl.split("?")[0]} → ${res.statusCode} · ${ms} ms${aborted}${errorBody ? `\n    ↳ ${errorBody}` : ""}`;
    if (res.statusCode >= 500) logger.error(line);
    else if (res.statusCode >= 400) logger.warn(line);
    else logger.log(line);
  };
  res.on("finish", log);
  res.on("close", log);
  next();
}
