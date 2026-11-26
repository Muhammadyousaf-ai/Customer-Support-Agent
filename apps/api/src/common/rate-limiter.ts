import { HttpException, HttpStatus } from "@nestjs/common";

/** Sliding-window limiter (in memory: one API instance). Keyed by e.g. `session:<id>` or `ip:<addr>`. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns seconds until a retry would succeed, or 0 if the request is allowed (and counted). */
  check(key: string): number {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((this.windowMs - (t - recent[0]!)) / 1000));
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.every((x) => t - x >= this.windowMs)) this.hits.delete(k);
    return 0;
  }

  /** Throws 429 with Retry-After semantics in the message. */
  enforce(key: string, what: string): void {
    const wait = this.check(key);
    if (wait) throw new HttpException(`Too many ${what}. Try again in ${wait}s.`, HttpStatus.TOO_MANY_REQUESTS);
  }
}
