import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query } from "@nestjs/common";
import { assignmentModeSchema, createStaffSchema } from "@support-ai/contracts";
import { z } from "zod";
import type { AuthUser } from "../auth/auth.types.js";
import { Auth, CurrentUser } from "../authorization/decorators/auth.decorator.js";
import { UsersService } from "../users/users.service.js";
import { AdminService } from "./admin.service.js";

const parse = <T extends z.ZodType>(schema: T, body: unknown): z.output<T> => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new BadRequestException(z.prettifyError(r.error));
  return r.data;
};
const page = z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() });
const auditQuery = z.object({ action: z.string().max(60).optional(), entityType: z.string().max(40).optional(), actor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() });
const availability = z.object({ available: z.boolean() }).strict();

@Controller("admin")
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService, @Inject(UsersService) private readonly users: UsersService) {}

  @Get("overview")
  @Auth("tickets.view_all")
  overview() {
    return this.admin.overview();
  }

  @Get("staff")
  @Auth("staff.manage")
  staff() {
    return this.users.staffList();
  }

  @Post("staff")
  @HttpCode(201)
  @Auth("staff.manage")
  createStaff(@Body() body: unknown, @CurrentUser() admin: AuthUser) {
    return this.admin.createStaff(admin, parse(createStaffSchema, body));
  }

  @Post("staff/:id/resend-invite")
  @HttpCode(204)
  @Auth("staff.manage")
  resend(@Param("id") id: string, @CurrentUser() admin: AuthUser) {
    return this.admin.resendInvite(admin, id);
  }

  @Post("staff/:id/availability")
  @HttpCode(204)
  @Auth("staff.manage")
  async setAvailability(@Param("id") id: string, @Body() body: unknown) {
    await this.users.setAvailability(id, parse(availability, body).available);
  }

  /** Suspend or re-activate a staff/customer account. */
  @Post("users/:id/suspend")
  @HttpCode(200)
  @Auth("staff.manage", "customers.manage")
  suspend(@Param("id") id: string, @CurrentUser() admin: AuthUser) {
    return this.admin.setStatus(admin, id, "suspended");
  }

  @Post("users/:id/activate")
  @HttpCode(200)
  @Auth("staff.manage", "customers.manage")
  activate(@Param("id") id: string, @CurrentUser() admin: AuthUser) {
    return this.admin.setStatus(admin, id, "active");
  }

  @Get("customers")
  @Auth("customers.manage")
  customers(@Query() q: unknown) {
    const p = parse(page, q);
    return this.admin.customers(p.q, p.limit, p.offset);
  }

  @Get("customers/:id/conversations")
  @Auth("customers.manage")
  conversations(@Param("id") id: string) {
    return this.admin.customerConversations(id);
  }

  @Get("audit-logs")
  @Auth("audit.view")
  audit(@Query() q: unknown) {
    return this.admin.auditLogs(parse(auditQuery, q));
  }

  @Get("settings")
  @Auth("assignment.configure")
  settings() {
    return this.admin.settings();
  }

  @Put("settings/assignment-mode")
  @Auth("assignment.configure")
  setMode(@Body() body: unknown, @CurrentUser() admin: AuthUser) {
    return this.admin.setAssignmentMode(admin, parse(assignmentModeSchema, body).mode);
  }

  @Get("outbox")
  @Auth("staff.manage")
  outbox() {
    return this.admin.outbox();
  }
}

/** Staff-facing self service. */
@Controller("me")
export class MeController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Put("availability")
  @HttpCode(204)
  @Auth("tickets.claim")
  async availability(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.users.setAvailability(user.id, parse(availability, body).available);
  }
}
