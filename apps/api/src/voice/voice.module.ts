import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module.js";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";
import { AgentDelegationService } from "./delegation/agent-delegation.service.js";
import { OpenAiRealtimeAdapter } from "./providers/openai-realtime/openai-realtime.adapter.js";
import { FakeLiveProvider } from "./providers/fake/fake-live.provider.js";
import { LIVE_PROVIDER, type LiveProvider } from "./providers/live-provider.js";
import { VoiceSessionRepository } from "./session/voice-session.repository.js";
import { VoiceController } from "./voice.controller.js";
import { VOICE_CONFIG, resolveVoiceConfig, type VoiceConfig } from "./voice.config.js";
import { VoiceGateway } from "./voice.gateway.js";
import { VoiceService } from "./voice.service.js";

/** Voice imports the agent module; it never rebuilds the graph. */
@Module({
  imports: [AgentModule],
  controllers: [VoiceController],
  providers: [
    { provide: VOICE_CONFIG, useFactory: (env: Env) => resolveVoiceConfig(env), inject: [ENV] },
    {
      provide: LIVE_PROVIDER,
      useFactory: (cfg: VoiceConfig, env: Env): LiveProvider =>
        cfg.provider === "fake" ? new FakeLiveProvider({ ...(env.VOICE_FAKE_UTTERANCES ? { utterances: env.VOICE_FAKE_UTTERANCES.split("|") } : {}), frameMs: env.VOICE_FAKE_FRAME_MS }) : new OpenAiRealtimeAdapter(cfg),
      inject: [VOICE_CONFIG, ENV],
    },
    VoiceSessionRepository, AgentDelegationService, VoiceService, VoiceGateway,
  ],
  exports: [VoiceService],
})
export class VoiceModule {}
