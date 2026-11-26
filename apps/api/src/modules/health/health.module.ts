import { Module } from "@nestjs/common";
import { AdminGuard } from "../../rag/admin.guard.js";
import { HealthController } from "./health.controller.js";

@Module({ controllers: [HealthController], providers: [AdminGuard] })
export class HealthModule {}
