import { Inject, Injectable, Optional, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "../auth/auth.service.js";
import { SessionsService } from "./sessions.service.js";

/**
 * Conversation access. Two credentials work: the conversation bearer token handed out at creation (anonymous demo sessions and the
 * transport for SSE/WebSocket), or the access token of the ACCOUNT that owns the conversation. Staff and admins do not get
 * conversation access this way: they see conversations only through tickets, with the ticket's own visibility rules.
 */
@Injectable()
export class SessionAuthService {
  constructor(
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Optional() @Inject(AuthService) private readonly auth?: AuthService,
  ) {}

  tokenFrom(req: Request): string | undefined {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) return header.slice(7);
    return typeof req.query.token === "string" ? req.query.token : undefined;
  }

  /** The signed-in user on this request, if it carries a valid access token (does not fail when absent). */
  async optionalUser(req: Request) {
    const token = this.tokenFrom(req);
    return token && token.split(".").length === 3 && this.auth ? this.auth.authenticate(token) : null;
  }

  /** 401 for "no such session" and "wrong token" alike, so session ids cannot be probed. */
  async authorize(sessionId: string, req: Request): Promise<void> {
    const token = this.tokenFrom(req);
    if (token && token.split(".").length === 3 && this.auth) {
      const user = await this.auth.authenticate(token);
      if (user && user.role === "customer" && (await this.sessions.ownerOf(sessionId)) === user.id) return;
      throw new UnauthorizedException("Missing or invalid session token.");
    }
    if (!(await this.sessions.authenticate(sessionId, token))) throw new UnauthorizedException("Missing or invalid session token.");
  }
}
