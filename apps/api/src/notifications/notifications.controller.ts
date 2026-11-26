import { Controller, Get, HttpCode, Inject, Param, ParseIntPipe, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Auth, CurrentUser } from "../authorization/decorators/auth.decorator.js";
import type { AuthUser } from "../auth/auth.types.js";
import { NotificationsService } from "./notifications.service.js";

const MAX_STREAM_MS = 5 * 60_000;

@Controller("me")
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get("notifications")
  @Auth()
  list(@CurrentUser() user: AuthUser) {
    return this.notifications.list(user.id);
  }

  @Post("notifications/read")
  @HttpCode(204)
  @Auth()
  async readAll(@CurrentUser() user: AuthUser) {
    await this.notifications.markRead(user.id);
  }

  @Post("notifications/:id/read")
  @HttpCode(204)
  @Auth()
  async readOne(@Param("id", ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    await this.notifications.markRead(user.id, id);
  }

  /**
   * Live feed for the signed-in user (new assignments, customer replies, staff replies, status changes). Fetch-based SSE with the
   * access token in a header. The stream ends after a few minutes so a revoked or expired token cannot stay connected forever; the
   * client reconnects with a fresh token and reloads the persisted notifications.
   */
  @Get("events")
  @Auth()
  stream(@CurrentUser() user: AuthUser, @Req() req: Request, @Res() res: Response): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 3000\n: connected\n\n");
    const sub = this.notifications.ofUser(user.id).subscribe((e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`));
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    const end = setTimeout(() => res.end(), MAX_STREAM_MS);
    const cleanup = () => { sub.unsubscribe(); clearInterval(ping); clearTimeout(end); };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }
}
