import { applyDecorators, createParamDecorator, type ExecutionContext, SetMetadata, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import type { AuthUser } from "../../auth/auth.types.js";
import { JwtAuthGuard } from "../guards/jwt-auth.guard.js";
import { PermissionsGuard } from "../guards/permissions.guard.js";
import type { Permission } from "../permissions.js";

export const PERMISSIONS_KEY = "permissions";

/** `@Auth()` = signed in. `@Auth("tickets.assign")` = signed in and the role grants (any of) the listed permissions. */
export const Auth = (...permissions: Permission[]) => applyDecorators(SetMetadata(PERMISSIONS_KEY, permissions), UseGuards(JwtAuthGuard, PermissionsGuard));

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest<Request>().user!);
