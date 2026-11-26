import { Injectable } from "@nestjs/common";

const CODE_RE = /\b\d{6}\b/g;
const PLACEHOLDER_RE = /\[CODE-\d+\]/g;
const CODE_TTL_MS = 5 * 60_000;

/** The only tool arguments that may receive a real secret. */
const SECRET_FIELDS: Record<string, string[]> = { verify_identity: ["verificationCode"] };

/**
 * Keeps verification codes out of everything that is persisted or sent to the model.
 * A 6 digit code in a customer message is replaced by a placeholder ([CODE-1]) before the message is stored,
 * checkpointed, traced or shown to the LLM. The real value lives only in this in-memory, per-run vault and is
 * substituted into tool arguments at the moment a tool runs. Codes are kept in memory for a few minutes across
 * turns of the same session, then forgotten. A restart also forgets them.
 */
@Injectable()
export class SecretVault {
  private readonly runs = new Map<string, Map<string, string>>();
  private readonly sessions = new Map<string, { codes: Map<string, string>; expiresAt: number }>();

  /** Returns the text with codes replaced by placeholders and remembers the real values for this run. */
  extract(runId: string, text: string, sessionId?: string): string {
    let known = this.runs.get(runId);
    if (!known && sessionId) {
      const prior = this.sessions.get(sessionId);
      known = prior && prior.expiresAt > Date.now() ? prior.codes : new Map<string, string>();
      this.sessions.set(sessionId, { codes: known, expiresAt: Date.now() + CODE_TTL_MS });
      const codes = known;
      setTimeout(() => {
        const current = this.sessions.get(sessionId);
        if (current?.codes === codes && current.expiresAt <= Date.now()) this.sessions.delete(sessionId);
      }, CODE_TTL_MS).unref();
    }
    known ??= new Map<string, string>();
    this.runs.set(runId, known);
    return text.replace(CODE_RE, (code) => {
      for (const [placeholder, value] of known) if (value === code) return placeholder;
      const placeholder = `[CODE-${known.size + 1}]`;
      known.set(placeholder, code);
      return placeholder;
    });
  }

  /**
   * Substitutes real values into tool arguments, but ONLY for the specific fields that legitimately need a secret
   * (verify_identity.verificationCode). A placeholder anywhere else (an escalation summary, a free-text note)
   * stays a placeholder, so a code can never be restored into a ticket, a log or another tool's input.
   */
  resolveArgs<T>(runId: string, tool: string, args: T): T {
    const fields = SECRET_FIELDS[tool];
    const known = this.runs.get(runId);
    if (!fields || !known?.size || !args || typeof args !== "object" || Array.isArray(args)) return args;
    const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
    for (const field of fields) {
      const v = out[field];
      if (typeof v === "string") out[field] = v.replace(PLACEHOLDER_RE, (p) => known.get(p) ?? p);
    }
    return out as T;
  }

  release(runId: string): void {
    this.runs.delete(runId);
  }

  clearSession(sessionId: string, runId: string): void {
    this.sessions.delete(sessionId);
    this.runs.delete(runId);
  }
}
