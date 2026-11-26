import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { SignJWT, jwtVerify } from "jose";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";
import type { Role } from "../authorization/permissions.js";

export interface AccessClaims { sub: string; role: Role; sid: string }
const ISSUER = "support-ai";
const AUDIENCE = "support-ai-web";

@Injectable()
export class TokenService {
  private readonly key: Uint8Array;
  constructor(@Inject(ENV) private readonly env: Env) {
    this.key = new TextEncoder().encode(env.JWT_SECRET);
  }

  get accessTtlSeconds(): number { return Math.round(this.env.ACCESS_TOKEN_TTL_MIN * 60); }

  signAccess(c: AccessClaims): Promise<string> {
    return new SignJWT({ role: c.role, sid: c.sid }).setProtectedHeader({ alg: "HS256" }).setSubject(c.sub).setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime(`${this.accessTtlSeconds}s`).sign(this.key);
  }

  /** Returns null for anything that is not a valid, unexpired token signed by us (wrong algorithm, issuer, audience...). */
  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
      if (typeof payload.sub !== "string" || typeof payload.sid !== "string" || typeof payload.role !== "string") return null;
      return { sub: payload.sub, sid: payload.sid, role: payload.role as Role };
    } catch {
      return null;
    }
  }

  /** Opaque random secret (refresh tokens, verification/reset/invite links). Only its SHA-256 is stored. */
  newSecret(): { token: string; hash: string } {
    const token = randomBytes(32).toString("base64url");
    return { token, hash: this.hashSecret(token) };
  }

  hashSecret(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
