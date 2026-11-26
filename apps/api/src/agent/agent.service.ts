import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { Command } from "@langchain/langgraph";
import { AGENT_EVENT_TYPES, type AcceptedMessage, type AgentRunResponse, type AgentRunStatus, type PendingActionView, type ResumeRunInput, type SessionView, type SendAgentMessageInput } from "@support-ai/contracts";
import type pg from "pg";
import { PG_POOL } from "../database/tokens.js";
import { SessionsService } from "../sessions/sessions.service.js";
import { AGENT_CONFIG, type AgentConfig } from "./config/agent.config.js";
import { AgentEventsService } from "./events/agent-events.service.js";
import { AgentTraceService } from "./events/agent-trace.service.js";
import { classifyConfirmationReply } from "./guardrails/confirmation-classifier.js";
import { SecretVault } from "./guardrails/secret-vault.js";
import { buildAgentGraph, type AgentGraph } from "./graph/agent.graph.js";
import { CheckpointerService } from "./memory/checkpointer.service.js";
import { ConversationMemoryService, type StoredMessage } from "./memory/conversation-memory.service.js";
import { PendingActionsService } from "./memory/pending-actions.service.js";
import type { ConfirmationInterrupt, ConfirmationResume } from "./nodes/confirmation.node.js";
import { metricsOf } from "./nodes/finalize.node.js";
import type { AgentDeps } from "./nodes/node-deps.js";
import { RunRegistry, RunsService, type RunRecord } from "./runs/runs.service.js";
import type { AgentStateType } from "./state/agent-state.js";
import { runWithTrace, traceIdFor } from "../observability/context/telemetry-context.js";
import { inTrace, withSpan, type SpanHandle } from "../observability/tracing/tracing.js";

const EMPTY_METRICS = { toolCalls: 0, iterations: 0, llmCalls: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };

/**
 * Entry point for chat and voice. It owns the turn lifecycle around the graph: one active run per session,
 * message de-duplication, pause/resume for confirmations, cancellation, and making sure a crash can never leave a
 * session blocked or a customer without an honest answer. All decisions are made inside the graph.
 */
@Injectable()
export class AgentService implements OnModuleInit {
  private readonly logger = new Logger(AgentService.name);
  private graph!: AgentGraph;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    @Inject("AGENT_DEPS") private readonly deps: AgentDeps,
    @Inject(CheckpointerService) private readonly checkpointer: CheckpointerService,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(RunsService) private readonly runs: RunsService,
    @Inject(RunRegistry) private readonly registry: RunRegistry,
    @Inject(ConversationMemoryService) private readonly memory: ConversationMemoryService,
    @Inject(PendingActionsService) private readonly pending: PendingActionsService,
    @Inject(AgentEventsService) private readonly events: AgentEventsService,
    @Inject(AgentTraceService) private readonly trace: AgentTraceService,
    @Inject(SecretVault) private readonly vault: SecretVault,
    @Inject(AGENT_CONFIG) private readonly cfg: AgentConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.init();
  }

  /** Builds the graph on the PostgreSQL checkpointer and frees sessions blocked by a crashed process. */
  async init(): Promise<void> {
    await this.checkpointer.setup();
    this.graph = buildAgentGraph(this.deps, this.checkpointer.saver);
    const reaped = await this.runs.reapStale(this.cfg.deadlineMs * 2);
    if (reaped) this.logger.warn(`marked ${reaped} stale run(s) as failed`);
  }

  // ---- sessions ---------------------------------------------------------------------------------------------------
  async createSession(userId?: string) {
    const { session, token } = await this.sessions.createWithToken(userId ? 24 * 60 : undefined, userId);
    return { sessionId: session.id, sessionToken: token, expiresAt: session.expiresAt.toISOString() };
  }

  // ---- a customer message (chat or voice transcript) ---------------------------------------------------------------
  /** Everything that must happen synchronously before a run can proceed (and can fail with 409). */
  private async prepare(sessionId: string, input: { message: string; clientMessageId: string; mode?: "chat" | "voice" }): Promise<
    | { kind: "duplicate"; message: StoredMessage }
    | { kind: "run"; run: RunRecord; mode: "chat" | "voice"; resumed: boolean; graphInput: unknown; messageId: number }
  > {
    const mode = input.mode ?? "chat";
    await this.assertAiActive(sessionId);
    // Same client message id => same result, never a second execution.
    const duplicate = await this.memory.findByClientId(sessionId, input.clientMessageId);
    if (duplicate?.runId) return { kind: "duplicate", message: duplicate };

    const paused = await this.runs.findPaused(sessionId);
    if (paused) {
      await this.runs.resume(paused.id); // atomic: a second concurrent message gets 409
      const { message } = await this.memory.append({ sessionId, role: "user", content: this.vault.extract(paused.id, input.message, sessionId), mode, runId: paused.id, clientMessageId: input.clientMessageId });
      const reply = classifyConfirmationReply(input.message);
      const payload: ConfirmationResume = reply === "other" ? { decision: "other", message: message.content } : { decision: reply };
      return { kind: "run", run: { ...paused, status: "running" }, mode, resumed: true, graphInput: new Command({ resume: payload }), messageId: message.id };
    }

    const run = await this.runs.start(sessionId, mode, input.clientMessageId); // 409 if a run is already executing
    try {
      const { message } = await this.memory.append({ sessionId, role: "user", content: this.vault.extract(run.id, input.message, sessionId), mode, runId: run.id, clientMessageId: input.clientMessageId });
      await this.abandonDanglingThread(sessionId);
      return { kind: "run", run, mode, resumed: false, graphInput: { sessionId, runId: run.id, turnId: run.turnId ?? randomUUID(), mode }, messageId: message.id };
    } catch (err) {
      await this.failRun(run, err);
      throw err;
    }
  }

  /** Synchronous: resolves when the run finishes or pauses. Used by the CLIs and tests. */
  async submitMessage(sessionId: string, input: Required<Pick<SendAgentMessageInput, "message" | "clientMessageId">> & { mode?: "chat" | "voice" }): Promise<AgentRunResponse> {
    const p = await this.prepare(sessionId, input);
    if (p.kind === "duplicate") return this.replay(p.message);
    return this.execute(p.run, p.mode, p.resumed, p.graphInput);
  }

  /**
   * 202 Accepted: validates and records the message, starts the run in the background and returns immediately.
   * Progress and the answer arrive over the event stream; the stored result is readable at GET /runs/:id.
   */
  async acceptMessage(sessionId: string, input: Required<Pick<SendAgentMessageInput, "message" | "clientMessageId">> & { mode?: "chat" | "voice" }): Promise<AcceptedMessage> {
    const p = await this.prepare(sessionId, input);
    if (p.kind === "duplicate") {
      const run = await this.requireRun(p.message.runId!);
      return { sessionId, messageId: p.message.id, runId: run.id, status: run.status === "running" || run.status === "executing_tool" ? "processing" : (run.status as AgentRunStatus), duplicate: true };
    }
    this.background(this.execute(p.run, p.mode, p.resumed, p.graphInput));
    return { sessionId, messageId: p.messageId, runId: p.run.id, status: "processing" };
  }

  /** Runs in the background; execute() handles its own errors, so this can never reject unhandled. */
  private background(work: Promise<unknown>): void {
    const tracked: Promise<unknown> = work.catch((err) => this.logger.error(`background run failed: ${err instanceof Error ? err.message : String(err)}`)).finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  /** Resolves when no background run is executing (graceful shutdown and tests). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /** Backstop: while humans own a conversation the AI must not answer or run business actions, whatever route asked. */
  async assertAiActive(sessionId: string): Promise<void> {
    if ((await this.sessions.handoverMode(sessionId)) !== "AI_ACTIVE") throw new ConflictException("A support specialist is handling this conversation.");
  }

  async handoverMode(sessionId: string) {
    return this.sessions.handoverMode(sessionId);
  }

  private async prepareResume(runId: string, input: ResumeRunInput) {
    const run = await this.requireRun(runId);
    await this.assertAiActive(run.sessionId);
    if (run.status !== "awaiting_confirmation") throw new ConflictException("This run is not waiting for confirmation.");
    const action = await this.pending.get(input.actionId);
    if (!action || action.runId !== run.id) throw new ConflictException("That action does not belong to this run.");
    await this.runs.resume(run.id);
    return { run: { ...run, status: "running" as const }, graphInput: new Command({ resume: { decision: input.decision, actionId: input.actionId } satisfies ConfirmationResume }) };
  }

  /** Explicit resume (API / buttons): names the exact action being confirmed or declined. */
  async resumeRun(runId: string, input: ResumeRunInput): Promise<AgentRunResponse> {
    const { run, graphInput } = await this.prepareResume(runId, input);
    return this.execute(run, run.mode, true, graphInput);
  }

  async acceptResume(runId: string, input: ResumeRunInput): Promise<AcceptedMessage> {
    const { run, graphInput } = await this.prepareResume(runId, input);
    this.background(this.execute(run, run.mode, true, graphInput));
    return { sessionId: run.sessionId, messageId: 0, runId: run.id, status: "processing" };
  }

  private async prepareCancel(runId: string): Promise<{ kind: "signalled" } | { kind: "paused"; run: RunRecord; graphInput: unknown }> {
    const run = await this.requireRun(runId);
    if (run.status === "awaiting_confirmation") {
      await this.runs.resume(run.id);
      return { kind: "paused", run: { ...run, status: "running" }, graphInput: new Command({ resume: { decision: "cancel" } satisfies ConfirmationResume }) };
    }
    if (run.status === "running" || run.status === "executing_tool") {
      await this.runs.requestCancel(run.id);
      this.registry.cancel(run.id);
      return { kind: "signalled" };
    }
    throw new ConflictException(`This run already finished (${run.status}).`);
  }

  /** Cancels an executing run (it stops at the next safe point and reports what was already committed) or a paused one. */
  async cancelRun(runId: string): Promise<AgentRunResponse | { cancelRequested: true }> {
    const c = await this.prepareCancel(runId);
    return c.kind === "signalled" ? { cancelRequested: true } : this.execute(c.run, c.run.mode, true, c.graphInput);
  }

  async acceptCancel(runId: string): Promise<{ cancelRequested: true; runId: string }> {
    const c = await this.prepareCancel(runId);
    if (c.kind === "paused") this.background(this.execute(c.run, c.run.mode, true, c.graphInput));
    return { cancelRequested: true, runId };
  }

  // ---- execution ----------------------------------------------------------------------------------------------------
  private async execute(run: RunRecord, mode: "chat" | "voice", resumed: boolean, input: unknown): Promise<AgentRunResponse> {
    const startedAt = Date.now();
    this.registry.register(run.id, this.cfg.deadlineMs); // first, so a cancel arriving from now on is seen
    await this.events.begin(run.id, run.sessionId);
    this.events.emit("run.started", run.sessionId, run.id, { mode, resumed });
    try {
      const thread = await this.sessions.threadId(run.sessionId);
      // One trace per run. After a confirmation pause the next segment joins the same trace, and only segment time
      // (not the customer's thinking time) counts as processing.
      const result = await this.traced(run, mode, resumed, async (span) => {
        const r = (await this.graph.invoke(input as never, { configurable: { thread_id: thread }, recursionLimit: 150 })) as AgentStateType & { __interrupt__?: Array<{ value: ConfirmationInterrupt }> };
        span.setAttr("outcome", r.__interrupt__?.length ? "paused" : String(r.status));
        return r;
      });
      const paused = result.__interrupt__?.[0]?.value;
      return paused ? await this.pause(run, result, paused, startedAt) : this.toResponse(run, result, startedAt);
    } catch (err) {
      return await this.failRun(run, err, startedAt);
    } finally {
      this.registry.release(run.id);
      this.vault.release(run.id);
      await this.events.end(run.id);
    }
  }

  private async traced<T>(run: RunRecord, mode: "chat" | "voice", resumed: boolean, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
    const { rows } = await this.pool.query<{ n: string }>("select count(*) as n from trace_events where run_id = $1 and type = 'run.started'", [run.id]).catch(() => ({ rows: [{ n: "1" }] }));
    const segment = Math.max(1, Number(rows[0]?.n ?? 1));
    const ctx = { traceId: traceIdFor(run.id), sessionId: run.sessionId, runId: run.id, mode, segment };
    return runWithTrace(ctx, () => inTrace(run.id, () => withSpan("agent.run", { category: "agent", attrs: { segment, resumed, mode } }, fn)));
  }

  /** The graph stopped at a confirmation: persist the question, mark the run paused, and tell the caller what is pending. */
  private async pause(run: RunRecord, state: AgentStateType, p: ConfirmationInterrupt, startedAt: number): Promise<AgentRunResponse> {
    const response = `${p.summary}. Shall I go ahead? (yes/no)`;
    const metrics = { ...metricsOf(this.deps, state, startedAt) };
    await this.memory.append({ sessionId: run.sessionId, role: "assistant", content: response, mode: run.mode, runId: run.id });
    await this.runs.finish(run.id, { status: "awaiting_confirmation", response, metrics, pendingActionId: p.actionId });
    this.events.emit("run.paused", run.sessionId, run.id, { reason: "awaiting_confirmation" });
    return { sessionId: run.sessionId, runId: run.id, status: "awaiting_confirmation", response, pendingAction: this.pendingView(p), sources: [], metrics };
  }

  private toResponse(run: RunRecord, state: AgentStateType, startedAt: number): AgentRunResponse {
    const status = (state.status === "running" || state.status === "executing_tool" ? "failed" : state.status) as AgentRunStatus;
    const sources = state.citedSourceIds.flatMap((id) => state.retrievedDocuments.filter((x) => x.id === id).map((x) => ({ document: x.document, heading: x.heading })));
    return {
      sessionId: run.sessionId, runId: run.id, status, response: state.finalResponse ?? "", sources,
      ...(state.escalationTicketId ? { escalationTicketId: state.escalationTicketId } : {}),
      metrics: metricsOf(this.deps, state, startedAt),
    };
  }

  /** Unexpected failure (a bug or an infrastructure outage outside the graph's own recovery). Never leave the run 'running'. */
  private async failRun(run: RunRecord, err: unknown, startedAt = Date.now()): Promise<AgentRunResponse> {
    this.logger.error(`run ${run.id} crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    const response = "I'm sorry, something went wrong on our side and I couldn't complete your request. Please try again in a moment.";
    const metrics = { ...EMPTY_METRICS, durationMs: Date.now() - startedAt };
    try {
      await this.runs.finish(run.id, { status: "failed", response, errorCode: "INTERNAL_ERROR", metrics });
      await this.memory.append({ sessionId: run.sessionId, role: "assistant", content: response, mode: run.mode, runId: run.id });
      this.events.emit("run.failed", run.sessionId, run.id, { errorCode: "INTERNAL_ERROR", message: response });
    } catch (secondary) {
      this.logger.error(`could not even record the failure of ${run.id}: ${secondary instanceof Error ? secondary.message : String(secondary)}`);
    }
    return { sessionId: run.sessionId, runId: run.id, status: "failed", response, sources: [], metrics };
  }

  /** A graph thread left paused by a crash (the DB says no run is waiting) can never be resumed: start a fresh generation. */
  private async abandonDanglingThread(sessionId: string): Promise<void> {
    const thread = await this.sessions.threadId(sessionId);
    const snapshot = await this.graph.getState({ configurable: { thread_id: thread } });
    if (snapshot.next.length > 0) {
      this.logger.warn(`abandoning dangling graph thread ${thread}`);
      await this.sessions.abandonThread(sessionId);
    }
  }

  // ---- reads ----------------------------------------------------------------------------------------------------------
  private pendingView(p: ConfirmationInterrupt): PendingActionView {
    return { id: p.actionId, type: p.type, summary: p.summary, ...(p.amountCents !== undefined ? { amountCents: p.amountCents } : {}), ...(p.currency ? { currency: p.currency } : {}), expiresAt: p.expiresAt, display: p.display ?? {} };
  }

  private async replay(message: StoredMessage): Promise<AgentRunResponse> {
    const run = await this.requireRun(message.runId!);
    if (run.status === "running" || run.status === "executing_tool") throw new ConflictException("This message is still being processed.");
    return this.responseForRun(run);
  }

  async responseForRun(run: RunRecord): Promise<AgentRunResponse> {
    const action = run.pendingActionId ? await this.pending.get(run.pendingActionId) : null;
    const pendingAction: PendingActionView | undefined =
      run.status === "awaiting_confirmation" && action?.status === "pending"
        ? { id: action.id, type: action.type, summary: action.summary, expiresAt: action.expiresAt.toISOString(), display: action.display, ...(action.amountCents !== null ? { amountCents: action.amountCents } : {}), ...(action.currency ? { currency: action.currency } : {}) }
        : undefined;
    return {
      sessionId: run.sessionId, runId: run.id, status: run.status as AgentRunStatus, response: run.response ?? "", sources: run.sources,
      ...(pendingAction ? { pendingAction } : {}), ...(run.escalationTicketId ? { escalationTicketId: run.escalationTicketId } : {}),
      metrics: run.metrics ?? EMPTY_METRICS,
    };
  }

  async requireRun(runId: string): Promise<RunRecord> {
    const run = await this.runs.get(runId);
    if (!run) throw new NotFoundException("Run not found.");
    return run;
  }

  listMessages(sessionId: string) {
    return this.memory.list(sessionId);
  }

  listRuns(sessionId: string) {
    return this.runs.listForSession(sessionId);
  }

  /** Persisted lifecycle events for a run (the same events the live stream carries). */
  async runEvents(runId: string) {
    const { rows } = await this.pool.query(
      "select seq, type, data, created_at as ts from trace_events where run_id = $1 and type = any($2) order by seq", [runId, AGENT_EVENT_TYPES as unknown as string[]],
    );
    return rows;
  }

  runTraces(runId: string) {
    return this.trace.tracesForRun(runId);
  }

  liveEvents(sessionId: string) {
    return this.events.ofSession(sessionId);
  }

  // ---- session views -----------------------------------------------------------------------------------------------------
  /** Everything the UI needs to restore a conversation after a refresh: title, active run and any pending confirmation. */
  async sessionView(sessionId: string): Promise<SessionView> {
    const [{ rows }, runs, last] = await Promise.all([
      this.pool.query<{ id: string; title: string | null; created_at: Date; identity_verified: boolean }>("select id, title, created_at, identity_verified from sessions where id = $1", [sessionId]),
      this.runs.listForSession(sessionId),
      this.pool.query<{ content: string; role: string; created_at: Date }>("select content, role, created_at from messages where session_id = $1 order by id desc limit 1", [sessionId]),
    ]);
    const s = rows[0];
    if (!s) throw new NotFoundException("Session not found.");
    const first = await this.pool.query<{ content: string }>("select content from messages where session_id = $1 and role = 'user' order by id asc limit 1", [sessionId]);
    const latest = runs[0];
    const active = latest && ["running", "executing_tool", "awaiting_confirmation", "awaiting_input"].includes(latest.status) ? latest : null;
    const pendingAction = latest?.status === "awaiting_confirmation" ? (await this.responseForRun(latest)).pendingAction ?? null : null;
    const firstText = first.rows[0]?.content;
    return {
      id: s.id,
      title: s.title ?? (firstText ? (firstText.length > 48 ? `${firstText.slice(0, 47)}\u2026` : firstText) : "New conversation"),
      createdAt: s.created_at.toISOString(),
      updatedAt: (last.rows[0]?.created_at ?? s.created_at).toISOString(),
      identityVerified: s.identity_verified,
      lastMessage: last.rows[0]?.content ?? null,
      activeRun: active ? { runId: active.id, status: active.status as AgentRunStatus } : null,
      pendingAction,
    };
  }

  async renameSession(sessionId: string, title: string): Promise<SessionView> {
    await this.pool.query("update sessions set title = $2 where id = $1", [sessionId, title]);
    return this.sessionView(sessionId);
  }
}
