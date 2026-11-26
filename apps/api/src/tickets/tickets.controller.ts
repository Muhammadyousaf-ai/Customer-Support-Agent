import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import { ticketAssignSchema, ticketCreateSchema, ticketMessageSchema, ticketNoteSchema, ticketPrioritySchema, ticketResolveSchema, searchTextSchema, ticketStatusSchema, TICKET_PRIORITIES, TICKET_STATUSES } from "@support-ai/contracts";
import type { Request } from "express";
import { z } from "zod";
import type { AuthUser } from "../auth/auth.types.js";
import { Auth, CurrentUser } from "../authorization/decorators/auth.decorator.js";
import { SessionAuthService } from "../sessions/session-auth.service.js";
import { TicketsService } from "./tickets.service.js";

const parse = <T extends z.ZodType>(schema: T, body: unknown): z.output<T> => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new BadRequestException(z.prettifyError(r.error));
  return r.data;
};
const listQuery = z.object({
  scope: z.enum(["mine", "unassigned", "all"]).optional(), status: z.enum(TICKET_STATUSES).optional(), priority: z.enum(TICKET_PRIORITIES).optional(), category: z.string().max(30).optional(),
  q: searchTextSchema, limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional(),
});

/** Ticket API. Permissions say who may call an endpoint; the service decides which tickets that person may see or change. */
@Controller()
export class TicketsController {
  constructor(@Inject(TicketsService) private readonly tickets: TicketsService, @Inject(SessionAuthService) private readonly sessions: SessionAuthService) {}

  @Get("tickets")
  @Auth("tickets.view_own", "tickets.view_assigned", "tickets.view_all")
  list(@Query() query: unknown, @CurrentUser() user: AuthUser) {
    return this.tickets.list(user, parse(listQuery, query));
  }

  @Get("tickets/stats/me")
  @Auth("tickets.view_assigned")
  stats(@CurrentUser() user: AuthUser) {
    return this.tickets.staffStats(user);
  }

  @Post("tickets")
  @HttpCode(201)
  @Auth("chat.use")
  create(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.tickets.createManual(user, parse(ticketCreateSchema, body));
  }

  @Get("tickets/:id")
  @Auth("tickets.view_own", "tickets.view_assigned", "tickets.view_all")
  detail(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.tickets.detail(id, { kind: "user", user });
  }

  @Post("tickets/:id/claim")
  @HttpCode(200)
  @Auth("tickets.claim")
  claim(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.tickets.claim(id, user);
  }

  @Post("tickets/:id/assign")
  @HttpCode(200)
  @Auth("tickets.assign")
  assign(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.tickets.assign(id, parse(ticketAssignSchema, body).staffId, user);
  }

  @Post("tickets/:id/messages")
  @HttpCode(201)
  @Auth("tickets.respond")
  message(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.tickets.addMessage(id, { kind: "user", user }, parse(ticketMessageSchema, body).body);
  }

  @Post("tickets/:id/notes")
  @HttpCode(201)
  @Auth("tickets.note")
  async note(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.tickets.addNote(id, user, parse(ticketNoteSchema, body).body);
    return { ok: true };
  }

  @Post("tickets/:id/status")
  @HttpCode(200)
  @Auth("tickets.resolve")
  status(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { status, note } = parse(ticketStatusSchema, body);
    return this.tickets.changeStatus(id, status, user, note);
  }

  @Post("tickets/:id/resolve")
  @HttpCode(200)
  @Auth("tickets.resolve")
  resolve(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    return this.tickets.resolve(id, user, parse(ticketResolveSchema, body).resolution);
  }

  @Post("tickets/:id/priority")
  @HttpCode(200)
  @Auth("tickets.resolve")
  async priority(@Param("id") id: string, @Body() body: unknown, @CurrentUser() user: AuthUser) {
    await this.tickets.setPriority(id, user, parse(ticketPrioritySchema, body).priority);
    return this.tickets.detail(id, { kind: "user", user });
  }

  @Post("tickets/:id/withdraw")
  @HttpCode(204)
  @Auth("tickets.view_own")
  async withdraw(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    await this.tickets.withdraw(id, { kind: "user", user });
  }

  // The same conversation seen from a chat session (anonymous demo sessions, or any session via its conversation token).
  @Get("sessions/:id/handover")
  async handover(@Param("id") id: string, @Req() req: Request) {
    await this.sessions.authorize(id, req);
    return this.tickets.handoverView(id);
  }

  @Get("sessions/:id/ticket")
  async sessionTicket(@Param("id") id: string, @Req() req: Request) {
    await this.sessions.authorize(id, req);
    const t = await this.tickets.activeTicketFor(id);
    if (!t) return null;
    return this.tickets.detail(t.id, { kind: "session", sessionId: id });
  }

  @Post("sessions/:id/ticket/messages")
  @HttpCode(201)
  async sessionTicketMessage(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    await this.sessions.authorize(id, req);
    const t = await this.tickets.activeTicketFor(id);
    if (!t) throw new BadRequestException("There is no open support ticket in this conversation.");
    return this.tickets.addMessage(t.id, { kind: "session", sessionId: id }, parse(ticketMessageSchema, body).body);
  }

  @Post("sessions/:id/ticket/withdraw")
  @HttpCode(204)
  async sessionWithdraw(@Param("id") id: string, @Req() req: Request) {
    await this.sessions.authorize(id, req);
    const t = await this.tickets.activeTicketFor(id);
    if (t) await this.tickets.withdraw(t.id, { kind: "session", sessionId: id });
  }
}
