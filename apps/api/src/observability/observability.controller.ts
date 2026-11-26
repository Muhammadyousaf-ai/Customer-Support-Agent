import { Controller, ForbiddenException, Get, Inject, Param, Query, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { timingSafeEqual } from "node:crypto";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";
import { SessionAuthService } from "../sessions/session-auth.service.js";
import { ObservabilityService } from "./observability.service.js";

type Access = "admin" | "owner";

/**
 * Developer/administrator inspection API.
 *  - admin  (x-admin-key, or no key configured outside production): everything, including prompts and tool arguments/results;
 *  - owner  (bearer token of the session that owns the data): timings, counts, tokens and cost for their own runs only.
 * Another conversation's token gets 401 (indistinguishable from "does not exist").
 */
@Controller("observability")
export class ObservabilityController {
  constructor(
    @Inject(ObservabilityService) private readonly obs: ObservabilityService,
    @Inject(SessionAuthService) private readonly auth: SessionAuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private isAdmin(req: Request): boolean {
    const expected = this.env.ADMIN_API_KEY;
    if (!expected) return this.env.NODE_ENV !== "production";
    const header = req.headers["x-admin-key"];
    const a = Buffer.from(typeof header === "string" ? header : "");
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * admin key -> "admin". Otherwise the bearer token must belong to `sessionId` (401 if not). The owner of a session sees
   * the admin detail only in development with no ADMIN_API_KEY configured (same rule as the other admin endpoints).
   */
  private async access(sessionId: string, req: Request): Promise<Access> {
    const configured = this.env.ADMIN_API_KEY;
    if (configured && req.headers["x-admin-key"] !== undefined) {
      if (this.isAdmin(req)) return "admin";
      throw new ForbiddenException("Invalid admin key");
    }
    await this.auth.authorize(sessionId, req);
    return !configured && this.env.NODE_ENV !== "production" ? "admin" : "owner";
  }

  private async forRun(runId: string, req: Request) {
    const ref = await this.obs.runRef(runId).catch(() => null);
    if (!ref) throw new UnauthorizedException("Missing or invalid credentials.");
    return { ref, access: await this.access(ref.sessionId, req) };
  }

  private adminOnly(req: Request) {
    if (!this.isAdmin(req)) throw new ForbiddenException("Administrator access required.");
  }

  @Get("sessions/:id/runs")
  async history(@Param("id") id: string, @Req() req: Request) {
    await this.access(id, req);
    return this.obs.history(id);
  }

  @Get("runs/:id")
  async run(@Param("id") id: string, @Req() req: Request) {
    await this.forRun(id, req);
    return this.obs.overview(id);
  }

  @Get("runs/:id/traces")
  async traces(@Param("id") id: string, @Req() req: Request) {
    const { access } = await this.forRun(id, req);
    const d = access === "admin";
    const [overview, spans, models, tools, retrievals, guardrails, usage, errors] = await Promise.all([
      this.obs.overview(id), this.obs.spans(id, d), this.obs.models(id, d), this.obs.tools(id, d), this.obs.retrievals(id), this.obs.guardrails(id), this.obs.usage(id), this.obs.errors(id),
    ]);
    return { access, overview, spans, models, tools, retrievals, guardrails, usage, errors };
  }

  @Get("runs/:id/spans")
  async spans(@Param("id") id: string, @Req() req: Request) {
    const { access } = await this.forRun(id, req);
    return this.obs.spans(id, access === "admin");
  }

  @Get("runs/:id/models")
  async models(@Param("id") id: string, @Req() req: Request) {
    const { access } = await this.forRun(id, req);
    return this.obs.models(id, access === "admin");
  }

  @Get("runs/:id/tools")
  async tools(@Param("id") id: string, @Req() req: Request) {
    const { access } = await this.forRun(id, req);
    return this.obs.tools(id, access === "admin");
  }

  @Get("runs/:id/retrievals")
  async retrievals(@Param("id") id: string, @Req() req: Request) {
    await this.forRun(id, req);
    return this.obs.retrievals(id);
  }

  @Get("runs/:id/guardrails")
  async guardrails(@Param("id") id: string, @Req() req: Request) {
    await this.forRun(id, req);
    return this.obs.guardrails(id);
  }

  @Get("runs/:id/usage")
  async usage(@Param("id") id: string, @Req() req: Request) {
    await this.forRun(id, req);
    return this.obs.usage(id);
  }

  @Get("runs/:id/errors")
  async errors(@Param("id") id: string, @Req() req: Request) {
    await this.forRun(id, req);
    return this.obs.errors(id);
  }

  @Get("voice/:id/metrics")
  async voice(@Param("id") id: string, @Req() req: Request) {
    const sessionId = await this.obs.sessionOfVoice(id).catch(() => null);
    if (!sessionId) throw new UnauthorizedException("Missing or invalid credentials.");
    await this.access(sessionId, req);
    return this.obs.voice(id);
  }

  @Get("pricing")
  pricing() {
    return this.obs.pricing();
  }

  @Get("summary")
  summary(@Query("days") days: string | undefined, @Req() req: Request) {
    this.adminOnly(req);
    return this.obs.summary(days ? Number(days) : 7);
  }
}
