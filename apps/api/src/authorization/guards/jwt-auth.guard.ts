import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "../../auth/auth.service.js";

/** Requires a valid access token (a JWT). Conversation bearer tokens are NOT accepted here: they are a different credential. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const user = token && token.split(".").length === 3 ? await this.auth.authenticate(token) : null;
    if (!user) throw new UnauthorizedException("Sign in required.");
    req.user = user;
    return true;
  }
}
