import { timingSafeEqual } from "node:crypto";
import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";

/**
 * Admin-only endpoints (ingest, list documents). Requires `x-admin-key` matching ADMIN_API_KEY.
 * With no key configured the endpoints are open in development and closed in production.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.env.ADMIN_API_KEY;
    if (!expected) {
      if (this.env.NODE_ENV === "production") throw new ForbiddenException("Admin API is disabled");
      return true;
    }
    const header = context.switchToHttp().getRequest<Request>().headers["x-admin-key"];
    const provided = Buffer.from(typeof header === "string" ? header : "");
    const wanted = Buffer.from(expected);
    if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
      throw new ForbiddenException("Invalid admin key");
    }
    return true;
  }
}
