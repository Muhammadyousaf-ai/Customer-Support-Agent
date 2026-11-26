import { Module } from "@nestjs/common";
import { AuditService } from "../audit/audit.service.js";
import { AdminController, MeController } from "./admin.controller.js";
import { AdminService } from "./admin.service.js";

@Module({ controllers: [AdminController, MeController], providers: [AdminService, AuditService] })
export class AdminModule {}
