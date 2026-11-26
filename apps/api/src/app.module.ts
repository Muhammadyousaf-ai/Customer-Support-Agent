import { Module } from "@nestjs/common";
import { ConfigModule } from "./config/config.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { RagModule } from "./rag/rag.module.js";
import { AgentModule } from "./agent/agent.module.js";
import { StreamingModule } from "./streaming/streaming.module.js";
import { ToolsModule } from "./tools/tools.module.js";
import { VoiceModule } from "./voice/voice.module.js";
import { AdminModule } from "./admin/admin.module.js";
import { KnowledgeBaseModule } from "./knowledge-base/knowledge-base.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { NotificationsModule } from "./notifications/notifications.module.js";
import { TicketsModule } from "./tickets/tickets.module.js";
import { BudgetModule } from "./budget/budget.module.js";
import { LifecycleModule } from "./lifecycle/lifecycle.module.js";
import { ObservabilityModule } from "./observability/observability.module.js";

@Module({ imports: [ConfigModule, DatabaseModule, HealthModule, RagModule, ToolsModule, AgentModule, StreamingModule, VoiceModule, ObservabilityModule, BudgetModule, LifecycleModule, AuthModule, NotificationsModule, TicketsModule, AdminModule, KnowledgeBaseModule] })
export class AppModule {}
