import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { changePasswordSchema, loginSchema, logoutSchema, refreshSchema, registerSchema, tokenPasswordSchema, verifyEmailSchema } from "@support-ai/contracts";
import type { Request } from "express";
import { z } from "zod";
import { RateLimiter } from "../common/rate-limiter.js";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";
import { Auth, CurrentUser } from "../authorization/decorators/auth.decorator.js";
import { UsersService } from "../users/users.service.js";
import type { AuthUser } from "./auth.types.js";
import { toPublicUser } from "./auth.types.js";
import { AuthService } from "./auth.service.js";

const parse = <T extends z.ZodType>(schema: T, body: unknown): z.output<T> => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new BadRequestException(z.prettifyError(r.error));
  return r.data;
};

/** Public account endpoints. Every one is rate limited per address; login also locks the account after repeated failures. */
@Controller("auth")
export class AuthController {
  private readonly limiter: RateLimiter;
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(UsersService) private readonly users: UsersService, @Inject(ENV) env: Env) {
    this.limiter = new RateLimiter(env.AUTH_RATE_LIMIT_PER_MIN);
  }

  private info(req: Request) { return { ip: req.ip, userAgent: req.headers["user-agent"] }; }
  private limit(req: Request, what: string) { this.limiter.enforce(`${what}:${req.ip}`, "attempts from this address"); }

  @Post("register")
  @HttpCode(201)
  register(@Body() body: unknown, @Req() req: Request) {
    this.limit(req, "register");
    return this.auth.register(parse(registerSchema, body));
  }

  @Post("verify-email")
  @HttpCode(204)
  async verifyEmail(@Body() body: unknown, @Req() req: Request) {
    this.limit(req, "verify");
    await this.auth.verifyEmail(parse(verifyEmailSchema, body).token);
  }

  @Post("login")
  @HttpCode(200)
  login(@Body() body: unknown, @Req() req: Request) {
    this.limit(req, "login");
    const { email, password } = parse(loginSchema, body);
    return this.auth.login(email, password, this.info(req));
  }

  @Post("refresh")
  @HttpCode(200)
  refresh(@Body() body: unknown, @Req() req: Request) {
    this.limit(req, "refresh");
    return this.auth.refresh(parse(refreshSchema, body).refreshToken, this.info(req));
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Body() body: unknown) {
    await this.auth.logout(parse(logoutSchema, body).refreshToken);
  }

  @Post("logout-all")
  @HttpCode(204)
  @Auth()
  async logoutAll(@CurrentUser() user: AuthUser) {
    await this.auth.revokeAll(user.id);
  }

  @Get("me")
  @Auth()
  async me(@CurrentUser() user: AuthUser) {
    return toPublicUser(await this.users.require(user.id));
  }

  @Get("sessions")
  @Auth()
  sessions(@CurrentUser() user: AuthUser) {
    return this.auth.listSessions(user.id, user.sessionId);
  }

  @Delete("sessions/:id")
  @HttpCode(204)
  @Auth()
  async revoke(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    await this.auth.revokeSession(user.id, id);
  }

  @Post("accept-invite")
  @HttpCode(204)
  async invite(@Body() body: unknown, @Req() req: Request) {
    this.limit(req, "invite");
    const { token, password } = parse(tokenPasswordSchema, body);
    await this.auth.acceptInvite(token, password);
  }

  @Post("change-password")
  @HttpCode(204)
  @Auth()
  async change(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { currentPassword, newPassword } = parse(changePasswordSchema, body);
    await this.auth.changePassword(user, currentPassword, newPassword);
  }
}
