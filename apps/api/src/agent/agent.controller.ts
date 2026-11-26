import { BudgetService } from "../budget/budget.service.js";
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, HttpCode, Inject, Optional, Param, Patch, Post, Query, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import { listOwnSessionsQuerySchema, renameSessionSchema, resumeRunSchema, sendAgentMessageSchema } from "@support-ai/contracts";
import type { Request } from "express";
import { z } from "zod";
import { RateLimiter } from "../common/rate-limiter.js";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";
import { AdminGuard } from "../rag/admin.guard.js";
import { Auth, CurrentUser } from "../authorization/decorators/auth.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { SessionsService } from "../sessions/sessions.service.js";
import { TicketsService } from "../tickets/tickets.service.js";
import { SessionAuthService } from "../sessions/session-auth.service.js";
import { AgentService } from "./agent.service.js";

const parse = <T extends z.ZodType>(schema: T, body: unknown): z.output<T> => {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(z.prettifyError(r.error));
  return r.data;
};

/**
 * Chat API. Submission is asynchronous: POST returns 202 immediately and progress arrives on the event stream
 * (see streaming/). Session ownership = bearer token from POST /sessions. Traces need the admin key as well.
 */
@Controller()
export class AgentController {
  private readonly perSession: RateLimiter;
  private readonly perIp: RateLimiter;

  constructor(
    @Inject(AgentService) private readonly agent: AgentService,
    @Inject(SessionAuthService) private readonly auth: SessionAuthService,
    @Inject(ENV) private readonly env: Env,
    @Inject(SessionsService) private readonly sessionsSvc: SessionsService,
    @Optional() @Inject(BudgetService) private readonly budget?: BudgetService,
    @Optional() @Inject(TicketsService) private readonly tickets?: TicketsService,
  ) {
    this.perSession = new RateLimiter(env.RATE_LIMIT_SESSION_PER_MIN);
    this.perIp = new RateLimiter(env.RATE_LIMIT_IP_PER_MIN);
  }

  private async authorizeRun(runId: string, req: Request) {
    const run = await this.agent.requireRun(runId).catch(() => null);
    if (!run) throw new UnauthorizedException("Missing or invalid session token.");
    await this.auth.authorize(run.sessionId, req);
    return run;
  }

  /** Anonymous demo session, or (with an access token) a conversation owned by that account. */
  @Post("sessions")
  async createSession(@Req() req: Request) {
    const user = await this.auth.optionalUser(req);
    if (!user && this.env.ALLOW_ANONYMOUS_SESSIONS !== "true") throw new UnauthorizedException("Sign in to start a conversation.");
    if (user && user.role !== "customer") throw new ForbiddenException("Only customer accounts start support conversations.");
    this.perIp.enforce(`ip:${req.ip}`, "requests from this address");
    return this.agent.createSession(user?.id);
  }

  /** The signed-in customer's conversations (any device), optionally filtered by `?q=` over titles and messages. */
  @Get("me/sessions")
  @Auth("conversations.own")
  mySessions(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    return this.sessionsSvc.listForUser(user.id, parse(listOwnSessionsQuerySchema, query).q);
  }

  /** Mints a fresh conversation token so a signed-in owner can resume a conversation they started elsewhere. */
  @Post("me/sessions/:id/token")
  @HttpCode(200)
  @Auth("conversations.own")
  async myToken(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    const token = await this.sessionsSvc.rotateToken(id, user.id);
    if (!token) throw new UnauthorizedException("Missing or invalid session token.");
    return { sessionId: id, sessionToken: token };
  }

  /** Removes a conversation from the signed-in customer's list on every device (soft delete). */
  @Delete("me/sessions/:id")
  @HttpCode(204)
  @Auth("conversations.own")
  async deleteMySession(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    if (!(await this.sessionsSvc.deleteForUser(id, user.id))) throw new NotFoundException("Conversation not found.");
  }

  @Get("sessions/:id")
  async session(@Param("id") id: string, @Req() req: Request) {
    await this.auth.authorize(id, req);
    return this.agent.sessionView(id);
  }

  @Patch("sessions/:id")
  async rename(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    await this.auth.authorize(id, req);
    return this.agent.renameSession(id, parse(renameSessionSchema, body).title);
  }

  /** 202 Accepted. A repeated clientMessageId returns the original run instead of executing again. */
  @Post("sessions/:id/messages")
  @HttpCode(202)
  async send(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    await this.auth.authorize(id, req);
    this.perIp.enforce(`ip:${req.ip}`, "requests from this address");
    this.perSession.enforce(`session:${id}`, "messages in this conversation");
    const input = parse(sendAgentMessageSchema, body); // validate first: a rejected request must not hold budget
    // While a human owns the conversation the message goes to the ticket thread, never to the AI.
    const routed = await this.tickets?.routeCustomerMessage(id, input.message, input.clientMessageId);
    if (routed) return routed;
    const hold = await this.budget?.reserve("run"); // 503 when draining or when the daily AI budget is used up
    try {
      return await this.agent.acceptMessage(id, input);
    } catch (err) {
      this.budget?.release(hold); // e.g. 409 while another run is active: nothing was started
      throw err;
    }
  }

  @Get("sessions/:id/messages")
  async messages(@Param("id") id: string, @Req() req: Request) {
    await this.auth.authorize(id, req);
    return this.agent.listMessages(id);
  }

  @Get("sessions/:id/runs")
  async runs(@Param("id") id: string, @Req() req: Request) {
    await this.auth.authorize(id, req);
    return this.agent.listRuns(id);
  }

  @Get("runs/:id")
  async run(@Param("id") id: string, @Req() req: Request) {
    return this.agent.responseForRun(await this.authorizeRun(id, req));
  }

  @Get("runs/:id/events")
  async runEvents(@Param("id") id: string, @Req() req: Request) {
    await this.authorizeRun(id, req);
    return this.agent.runEvents(id);
  }

  @Post("runs/:id/resume")
  @HttpCode(202)
  async resume(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    await this.authorizeRun(id, req);
    const input = parse(resumeRunSchema, body);
    const hold = await this.budget?.reserve("run");
    try {
      return await this.agent.acceptResume(id, input);
    } catch (err) {
      this.budget?.release(hold);
      throw err;
    }
  }

  @Post("runs/:id/cancel")
  @HttpCode(202)
  async cancel(@Param("id") id: string, @Req() req: Request) {
    await this.authorizeRun(id, req);
    return this.agent.acceptCancel(id);
  }

  @Get("runs/:id/traces")
  @UseGuards(AdminGuard)
  async traces(@Param("id") id: string) {
    await this.agent.requireRun(id);
    return this.agent.runTraces(id);
  }
}
