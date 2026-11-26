import { Global, Module } from "@nestjs/common";
import { AuditService } from "../audit/audit.service.js";
import { SessionAuthService } from "../sessions/session-auth.service.js";
import { SessionsService } from "../sessions/sessions.service.js";
import { TicketsController } from "./tickets.controller.js";
import { TicketsService } from "./tickets.service.js";

/** Global so the escalation tool, chat controller and voice delegation can route to humans without importing this module. */
@Global()
@Module({ controllers: [TicketsController], providers: [TicketsService, SessionsService, SessionAuthService, AuditService], exports: [TicketsService] })
export class TicketsModule {}
