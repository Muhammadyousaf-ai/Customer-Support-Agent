import type { AgentEventPayloads, SseEnvelope } from "@support-ai/contracts";
import type { RunStatus, RunView, ToolExecution } from "../types";

export interface ChatEventState {
  /** Highest session sequence applied. Anything at or below it is a duplicate and is ignored. */
  lastSequence: number;
  runs: Record<string, RunView>;
  order: string[];
  activeRunId: string | null;
}

export const initialEventState = (): ChatEventState => ({ lastSequence: 0, runs: {}, order: [], activeRunId: null });

const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled"];
export const isBusy = (s: RunStatus) => s === "processing" || s === "streaming";
export const isTerminal = (s: RunStatus) => TERMINAL.includes(s);

const blankRun = (runId: string): RunView => ({ runId, status: "processing", tools: [], sources: [], guardrails: [], streamingText: "", pendingAction: null });

type P<K extends keyof AgentEventPayloads> = AgentEventPayloads[K];

/**
 * Pure reducer from backend events to UI state. Duplicate or out-of-order events (same or lower sequence) are
 * ignored, so a replay after reconnecting can never double-render anything.
 */
export function reduceEvent(state: ChatEventState, e: SseEnvelope): ChatEventState {
  if (e.sequence <= state.lastSequence) return state;
  const prev = state.runs[e.runId] ?? blankRun(e.runId);
  let run: RunView = { ...prev };

  switch (e.type) {
    case "run.started": {
      const p = e.payload as P<"run.started">;
      run = p.resumed ? { ...run, status: "processing", pendingAction: null } : { ...blankRun(e.runId) };
      break;
    }
    case "tool.started": {
      const p = e.payload as P<"tool.started">;
      const existing = run.tools.find((t) => t.id === p.toolCallId);
      const attempt = p.attempt ?? 1;
      const row: ToolExecution = { id: p.toolCallId, tool: p.tool, status: attempt > 1 ? "retrying" : "running", attempt, startedSequence: existing?.startedSequence ?? e.sequence };
      // The synthetic "awaiting confirmation" row is resolved once the confirmed action actually starts.
      const tools = run.tools.map((t) => (t.status === "awaiting_confirmation" ? { ...t, status: "completed" as const } : t));
      run = { ...run, status: run.status === "streaming" ? run.status : "processing", pendingAction: null, tools: existing ? tools.map((t) => (t.id === p.toolCallId ? { ...t, ...row } : t)) : [...tools, row] };
      break;
    }
    case "tool.completed": {
      const p = e.payload as P<"tool.completed">;
      run = { ...run, tools: patchTool(run.tools, p.toolCallId, { status: "completed", durationMs: p.durationMs, attempt: p.attempt ?? 1 }) };
      const r = p.result;
      if (p.tool === "issue_refund" && r && typeof r.refundId === "string") {
        run.refund = { refundId: r.refundId, paymentId: String(r.paymentId ?? ""), amountCents: Number(r.amountCents ?? 0), currency: String(r.currency ?? "USD"), simulated: r.simulated !== false };
      }
      break;
    }
    case "tool.failed": {
      const p = e.payload as P<"tool.failed">;
      run = { ...run, tools: patchTool(run.tools, p.toolCallId, { status: "failed", durationMs: p.durationMs, errorCode: p.errorCode, attempt: p.attempt ?? 1 }) };
      break;
    }
    case "retrieval.completed": {
      const p = e.payload as P<"retrieval.completed">;
      const merged = new Map(run.sources.map((s) => [`${s.document}#${s.heading}`, s]));
      for (const s of p.sources) {
        const k = `${s.document}#${s.heading}`;
        const old = merged.get(k);
        if (!old || s.similarity > old.similarity) merged.set(k, s);
      }
      run = { ...run, sources: [...merged.values()] };
      break;
    }
    case "guardrail.passed": {
      const p = e.payload as P<"guardrail.passed">;
      run = { ...run, guardrails: upsertGuardrail(run.guardrails, { guardrail: p.guardrail, passed: true, detail: p.detail }) };
      break;
    }
    case "guardrail.failed": {
      const p = e.payload as P<"guardrail.failed">;
      run = { ...run, guardrails: upsertGuardrail(run.guardrails, { guardrail: p.guardrail, passed: false, detail: p.reason, action: p.action }) };
      break;
    }
    case "clarification.required": {
      const p = e.payload as P<"clarification.required">;
      run = { ...run, clarification: { question: p.question, requiredFields: p.requiredFields }, status: "awaiting_input" };
      break;
    }
    case "confirmation.required": {
      const p = e.payload as P<"confirmation.required">;
      const tools: ToolExecution[] = [...run.tools.filter((t) => t.id !== `action:${p.actionId}`), { id: `action:${p.actionId}`, tool: "confirmation", status: "awaiting_confirmation", attempt: 1, detail: p.summary, startedSequence: e.sequence }];
      run = { ...run, tools, status: "awaiting_confirmation", pendingAction: { id: p.actionId, type: p.type, summary: p.summary, amountCents: p.amountCents, currency: p.currency, expiresAt: p.expiresAt, display: p.display } };
      break;
    }
    case "run.paused": {
      const p = e.payload as P<"run.paused">;
      run = { ...run, status: p.reason };
      break;
    }
    case "response.delta": {
      const p = e.payload as P<"response.delta">;
      run = { ...run, streamingText: run.streamingText + p.text, status: "streaming" };
      break;
    }
    case "response.completed": {
      const p = e.payload as P<"response.completed">;
      run = { ...run, finalText: p.text, streamingText: p.text, messageId: p.messageId };
      break;
    }
    case "escalation.created": {
      const p = e.payload as P<"escalation.created">;
      run = { ...run, ticket: { ticketId: p.ticketId, reason: p.reason, priority: p.priority, status: "open" } };
      break;
    }
    case "usage.updated":
      run = { ...run, usage: e.payload as P<"usage.updated"> };
      break;
    case "run.completed": {
      const p = e.payload as P<"run.completed">;
      run = { ...run, status: p.status === "awaiting_input" ? "awaiting_input" : "completed", pendingAction: null, tools: settle(run.tools, "cancelled") };
      break;
    }
    case "run.failed": {
      const p = e.payload as P<"run.failed">;
      run = { ...run, status: "failed", pendingAction: null, error: { code: p.errorCode, message: p.message }, tools: settle(run.tools, "failed") };
      break;
    }
    case "run.cancelled":
      run = { ...run, status: "cancelled", pendingAction: null, tools: settle(run.tools, "cancelled") };
      break;
    default:
      break; // context.loaded, decision.completed: not rendered
  }

  const runs = { ...state.runs, [e.runId]: run };
  const order = state.order.includes(e.runId) ? state.order : [...state.order, e.runId];
  return { lastSequence: e.sequence, runs, order, activeRunId: e.runId };
}

const patchTool = (tools: ToolExecution[], id: string, patch: Partial<ToolExecution>) => tools.map((t) => (t.id === id ? { ...t, ...patch } : t));
const upsertGuardrail = (list: RunView["guardrails"], g: RunView["guardrails"][number]) => [...list.filter((x) => x.guardrail !== g.guardrail), g];
/** When a run ends, anything still "running" or "awaiting confirmation" did not finish: mark it explicitly. */
const settle = (tools: ToolExecution[], as: "cancelled" | "failed") => tools.map((t) => (t.status === "running" || t.status === "retrying" || t.status === "awaiting_confirmation" ? { ...t, status: as === "failed" ? ("failed" as const) : ("cancelled" as const) } : t));

/** Seeds UI state from the REST session view (used on refresh before/while the stream replays). */
export function hydrateFromSession(state: ChatEventState, view: { activeRun: { runId: string; status: string } | null; pendingAction: RunView["pendingAction"] }): ChatEventState {
  if (!view.activeRun || state.runs[view.activeRun.runId]) return state;
  const status: RunStatus = view.activeRun.status === "awaiting_confirmation" ? "awaiting_confirmation" : view.activeRun.status === "awaiting_input" ? "awaiting_input" : "processing";
  const run: RunView = { ...blankRun(view.activeRun.runId), status, pendingAction: view.pendingAction };
  return { ...state, runs: { ...state.runs, [run.runId]: run }, order: [...state.order, run.runId], activeRunId: run.runId };
}
