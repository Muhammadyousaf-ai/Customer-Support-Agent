import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type { AgentRunResponse, PendingActionView } from "@support-ai/contracts";
import { filter, type Subscription } from "rxjs";
import { AgentService } from "../../agent/agent.service.js";
import { AgentEventsService } from "../../agent/events/agent-events.service.js";

export interface TrustedVoiceContext {
  /** Resolved from the authenticated voice session, never from what the model sent. */
  sessionId: string;
  voiceSessionId: string;
  turnId: string;
}

export interface DelegationResult {
  status: AgentRunResponse["status"] | "busy" | "timeout" | "handover";
  runId?: string;
  answer: string;
  pendingAction?: PendingActionView;
  escalationTicketId?: string;
  durationMs: number;
}

const TERMINAL = new Set(["completed", "escalated", "cancelled", "failed", "awaiting_confirmation", "awaiting_input"]);
const RUN_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled", "run.paused"]);

/**
 * Voice has no agent of its own. A spoken request goes through the same AgentService as a typed one, so
 * guardrails, tool authorization, confirmation and persistence are identical. Identity comes from the stored session.
 */
@Injectable()
export class AgentDelegationService {
  constructor(
    @Inject(AgentService) private readonly agent: AgentService,
    @Inject(AgentEventsService) private readonly events: AgentEventsService,
  ) {}

  /** The turn id doubles as the agent's clientMessageId, so the same spoken turn can never run twice. */
  async resolveRequest(ctx: TrustedVoiceContext, request: string, opts: { timeoutMs: number; onRun?: (runId: string) => void; signal?: AbortSignal }): Promise<DelegationResult> {
    const started = Date.now();
    if ((await this.agent.handoverMode(ctx.sessionId)) !== "AI_ACTIVE") {
      return { status: "handover", answer: "A support specialist is handling your conversation now, so I can't continue here. Please check the chat for their reply.", durationMs: Date.now() - started };
    }
    let accepted;
    try {
      accepted = await this.agent.acceptMessage(ctx.sessionId, { message: request, clientMessageId: ctx.turnId, mode: "voice" });
    } catch (err) {
      if (err instanceof ConflictException) return { status: "busy", answer: "I'm still working on your previous request. One moment, please.", durationMs: Date.now() - started };
      throw err;
    }
    opts.onRun?.(accepted.runId);
    const run = await this.waitForRun(accepted.runId, opts.timeoutMs, opts.signal);
    if (!run) return { status: "timeout", runId: accepted.runId, answer: "That is taking longer than expected. I'll keep working on it and the answer will appear in the chat.", durationMs: Date.now() - started };
    return {
      status: run.status, runId: run.runId, answer: run.response,
      ...(run.pendingAction ? { pendingAction: run.pendingAction } : {}), ...(run.escalationTicketId ? { escalationTicketId: run.escalationTicketId } : {}),
      durationMs: Date.now() - started,
    };
  }

  /** Wakes on the run's lifecycle events and re-checks the database (the source of truth), with a polling fallback. */
  private async waitForRun(runId: string, timeoutMs: number, signal?: AbortSignal): Promise<AgentRunResponse | null> {
    const deadline = Date.now() + timeoutMs;
    let wake: (() => void) | undefined;
    const sub: Subscription = this.events.events$.pipe(filter((e) => e.runId === runId && RUN_EVENTS.has(e.type))).subscribe(() => wake?.());
    try {
      for (;;) {
        const run = await this.agent.requireRun(runId);
        if (TERMINAL.has(run.status)) return this.agent.responseForRun(run);
        const left = deadline - Date.now();
        if (left <= 0 || signal?.aborted) return null;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, Math.min(400, left));
          wake = () => { clearTimeout(t); resolve(); };
        });
      }
    } finally {
      sub.unsubscribe();
    }
  }

  /**
   * Barge-in reconciliation. Only a run that is still executing is cancelled (it stops at the next safe point and
   * reports what is already committed). A run waiting for confirmation is left pending for the customer's next
   * words, and a committed refund is never undone by an interruption.
   */
  async reconcileInterrupted(runId: string): Promise<"cancel_requested" | "left_pending" | "already_finished"> {
    const run = await this.agent.requireRun(runId).catch(() => null);
    if (!run) return "already_finished";
    if (run.status === "awaiting_confirmation" || run.status === "awaiting_input") return "left_pending";
    if (run.status !== "running" && run.status !== "executing_tool") return "already_finished";
    try {
      await this.agent.acceptCancel(runId);
      return "cancel_requested";
    } catch (err) {
      if (err instanceof ConflictException) return "already_finished";
      throw err;
    }
  }

  /** Resolves when no run is executing for this session (used to serialize a barge-in turn behind the cancelled one). */
  async settle(runId: string | undefined, timeoutMs: number): Promise<void> {
    if (!runId) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await this.agent.requireRun(runId).catch(() => null);
      if (!run || TERMINAL.has(run.status)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
