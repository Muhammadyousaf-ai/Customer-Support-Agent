import { Controller, Get, Inject, Param, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { SessionAuthService } from "../sessions/session-auth.service.js";
import { SseService } from "./sse.service.js";

/**
 * GET /v1/sessions/:id/events. Authenticated with the session bearer token (header, or ?token= for EventSource).
 * The browser client uses authenticated fetch-based SSE so the token never has to go in a URL.
 */
@Controller()
export class SseController {
  constructor(
    @Inject(SseService) private readonly sse: SseService,
    @Inject(SessionAuthService) private readonly auth: SessionAuthService,
  ) {}

  @Get("sessions/:id/events")
  async stream(@Param("id") id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.auth.authorize(id, req);
    await this.sse.open(id, req, res);
  }
}
