import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module.js";
import { ConnectionManager } from "./connection-manager.service.js";
import { EventPublisherService } from "./event-publisher.service.js";
import { EventReplayService } from "./event-replay.service.js";
import { HeartbeatService } from "./heartbeat.service.js";
import { SseController } from "./sse.controller.js";
import { SseService } from "./sse.service.js";

@Module({
  imports: [AgentModule],
  controllers: [SseController],
  providers: [SseService, EventPublisherService, EventReplayService, ConnectionManager, HeartbeatService],
})
export class StreamingModule {}
