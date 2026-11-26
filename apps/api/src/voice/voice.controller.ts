import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { createVoiceSessionSchema } from "@support-ai/contracts";
import type { Request } from "express";
import { z } from "zod";
import { RateLimiter } from "../common/rate-limiter.js";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";
import { SessionAuthService } from "../sessions/session-auth.service.js";
import { VoiceService } from "./voice.service.js";

const parse = <T extends z.ZodType>(schema: T, body: unknown): z.output<T> => {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new BadRequestException(z.prettifyError(r.error));
  return r.data;
};

/** Voice REST: session setup and management. Audio itself flows over the WebSocket (voice.gateway.ts). */
@Controller()
export class VoiceController {
  private readonly creates = new RateLimiter(10);

  constructor(
    @Inject(VoiceService) private readonly voice: VoiceService,
    @Inject(SessionAuthService) private readonly auth: SessionAuthService,
    @Inject(ENV) _env: Env,
  ) {}

  /** Ownership of a voice session = ownership of its application session. 401 hides whether the id exists. */
  private async authorizeVoice(voiceSessionId: string, req: Request) {
    const record = await this.voice.requireSession(voiceSessionId).catch(() => null);
    if (!record) await this.auth.authorize("none", req); // always rejects with the same 401
    await this.auth.authorize(record!.sessionId, req);
    return record!;
  }

  @Post("sessions/:id/voice")
  @HttpCode(201)
  async create(@Param("id") id: string, @Body() body: unknown, @Req() req: Request) {
    await this.auth.authorize(id, req);
    this.creates.enforce(`voice:${id}`, "voice sessions started");
    return this.voice.createSession(id, parse(createVoiceSessionSchema, body).voice);
  }

  @Get("sessions/:id/voice")
  async status(@Param("id") id: string, @Req() req: Request) {
    await this.auth.authorize(id, req);
    return this.voice.status(id);
  }

  @Delete("sessions/:id/voice")
  async end(@Param("id") id: string, @Req() req: Request) {
    await this.auth.authorize(id, req);
    return this.voice.endSession(id);
  }

  @Post("voice/:id/reconnect")
  @HttpCode(201)
  async reconnect(@Param("id") id: string, @Req() req: Request) {
    await this.authorizeVoice(id, req);
    return this.voice.reconnect(id);
  }

  @Get("voice/:id/metrics")
  async metrics(@Param("id") id: string, @Req() req: Request) {
    await this.authorizeVoice(id, req);
    return this.voice.metrics(id);
  }

  @Get("voice/:id/turns")
  async turns(@Param("id") id: string, @Req() req: Request) {
    await this.authorizeVoice(id, req);
    return this.voice.turns(id);
  }
}
