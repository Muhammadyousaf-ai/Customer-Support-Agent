import { createHash, randomBytes } from "node:crypto";
import { ConflictException, Inject, Injectable, Optional, Logger, NotFoundException, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { VOICE_WS_PATH, type VoiceMetricsView, type VoiceSessionView } from "@support-ai/contracts";
import { BudgetService } from "../budget/budget.service.js";
import { AgentService } from "../agent/agent.service.js";
import { AgentDelegationService } from "./delegation/agent-delegation.service.js";
import { LIVE_PROVIDER, type LiveProvider } from "./providers/live-provider.js";
import { VoiceSessionRepository, type VoiceSessionRecord } from "./session/voice-session.repository.js";
import { VoiceConnection, type VoiceSocket } from "./voice-connection.js";
import { VOICE_CONFIG, type VoiceConfig } from "./voice.config.js";

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** Creates voice sessions and tickets and owns the live connections of this process. */
@Injectable()
export class VoiceService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(VoiceService.name);
  private readonly live = new Map<string, VoiceConnection>();
  private readonly reservations = new Map<string, string | undefined>();

  constructor(
    @Inject(VOICE_CONFIG) readonly cfg: VoiceConfig,
    @Inject(LIVE_PROVIDER) private readonly provider: LiveProvider,
    @Inject(VoiceSessionRepository) private readonly repo: VoiceSessionRepository,
    @Inject(AgentDelegationService) private readonly delegation: AgentDelegationService,
    @Inject(AgentService) private readonly agent: AgentService,
    @Optional() @Inject(BudgetService) private readonly budget?: BudgetService,
  ) {}

  async onModuleInit(): Promise<void> {
    const orphans = await this.repo.endOrphans([]);
    if (orphans) this.logger.warn(`closed ${orphans} voice session(s) left active by a previous process`);
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.live.values()].map((c) => c.end("server_shutdown", true)));
  }

  private view(r: VoiceSessionRecord, ticket?: { value: string; expiresAt: Date }): VoiceSessionView {
    return {
      sessionId: r.sessionId, voiceSessionId: r.id, status: r.status, websocketPath: VOICE_WS_PATH,
      ...(ticket ? { ticket: ticket.value, ticketExpiresAt: ticket.expiresAt.toISOString() } : {}),
      maxSessionMinutes: this.cfg.maxSessionMs / 60_000,
      audio: { inputSampleRate: this.cfg.inputSampleRate, outputSampleRate: this.cfg.outputSampleRate, chunkDurationMs: this.cfg.chunkDurationMs },
    };
  }

  private newTicket() {
    const value = randomBytes(24).toString("base64url");
    return { value, hash: hash(value), expiresAt: new Date(Date.now() + this.cfg.ticketTtlMs) };
  }

  /** One live voice session per application session: a newer one supersedes (and ends) the old one. */
  async createSession(sessionId: string, voice?: string): Promise<VoiceSessionView> {
    if (this.cfg.provider === "openai" && !this.cfg.apiKey) throw new ConflictException("Voice is not configured on this server.");
    const existing = await this.repo.activeForSession(sessionId);
    if (existing) {
      const conn = this.live.get(existing.id);
      if (conn) await conn.end("superseded", false);
      else await this.repo.setStatus(existing.id, "ended", { endReason: "superseded" });
    }
    const reservation = await this.budget?.reserve("voice"); // 503 when draining or the daily budget is used up
    this.reservations.set(sessionId, reservation);
    const ticket = this.newTicket();
    const record = await this.repo.create({ sessionId, model: this.provider.model, voice: voice ?? this.cfg.voice, ticketHash: ticket.hash, ticketTtlMs: this.cfg.ticketTtlMs });
    return this.view(record, { value: ticket.value, expiresAt: ticket.expiresAt });
  }

  /** New short-lived ticket for the same voice session, so a browser that lost its socket can re-attach. */
  async reconnect(voiceSessionId: string): Promise<VoiceSessionView> {
    const record = await this.requireSession(voiceSessionId);
    if (record.status === "ended" || record.status === "failed") throw new ConflictException("This voice session has ended. Start a new one.");
    const ticket = this.newTicket();
    await this.repo.issueTicket(record.id, ticket.hash, this.cfg.ticketTtlMs);
    return this.view(record, { value: ticket.value, expiresAt: ticket.expiresAt });
  }

  async requireSession(id: string): Promise<VoiceSessionRecord> {
    const r = await this.repo.get(id);
    if (!r) throw new NotFoundException("Voice session not found.");
    return r;
  }

  async status(sessionId: string): Promise<VoiceSessionView | { status: "none" }> {
    const r = await this.repo.activeForSession(sessionId);
    return r ? this.view(r) : { status: "none" };
  }

  async endSession(sessionId: string): Promise<{ ended: boolean }> {
    const r = await this.repo.activeForSession(sessionId);
    if (!r) return { ended: false };
    const conn = this.live.get(r.id);
    if (conn) await conn.end("api_end", false);
    else await this.repo.setStatus(r.id, "ended", { endReason: "api_end" });
    return { ended: true };
  }

  /** Called by the gateway after the ticket is consumed. Reuses the live connection when the browser is re-attaching. */
  open(record: VoiceSessionRecord, socket: VoiceSocket): VoiceConnection {
    const existing = this.live.get(record.id);
    if (existing && !existing.isEnded) {
      existing.attach(socket);
      return existing;
    }
    const conn = new VoiceConnection(record, socket, {
      cfg: this.cfg, provider: this.provider, repo: this.repo, delegation: this.delegation,
      recentMessages: async (sessionId, limit) => (await this.agent.listMessages(sessionId)).slice(-limit),
    }, (id) => { this.live.delete(id); this.budget?.release(this.reservations.get(record.sessionId)); this.reservations.delete(record.sessionId); });
    this.live.set(record.id, conn);
    return conn;
  }

  consumeTicket(ticket: string): Promise<VoiceSessionRecord | null> {
    return this.repo.consumeTicket(hash(ticket));
  }

  connection(id: string): VoiceConnection | undefined {
    return this.live.get(id);
  }

  async metrics(voiceSessionId: string): Promise<VoiceMetricsView | unknown> {
    const live = this.live.get(voiceSessionId);
    if (live) return live.metricsView();
    await this.requireSession(voiceSessionId);
    return (await this.repo.usageMetrics(voiceSessionId)) ?? null;
  }

  async turns(voiceSessionId: string) {
    await this.requireSession(voiceSessionId);
    return this.repo.turns(voiceSessionId);
  }

  async idle(): Promise<void> {
    await Promise.all([...this.live.values()].map((c) => c.idle()));
  }
}
