import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { PERMISSIONS_KEY } from "../decorators/auth.decorator.js";
import { can, type Permission } from "../permissions.js";

/** Runs after JwtAuthGuard. Passes when the user's role grants ANY of the listed permissions. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!required?.length) return true;
    const user = ctx.switchToHttp().getRequest<Request>().user;
    if (!user) throw new UnauthorizedException("Sign in required.");
    if (!required.some((p) => can(user.role, p))) throw new ForbiddenException("You do not have permission to do this.");
    return true;
  }
}
