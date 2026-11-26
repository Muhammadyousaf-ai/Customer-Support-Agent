import type { ProviderFunctionCall } from "../providers/live-provider.js";
import { SUPPORT_TOOL_NAME, supportRequestSchema } from "./support-tool.definition.js";

export interface FunctionResponse { id: string; name: string; response: Record<string, unknown> }

export interface CallContext { turnId: string }

interface Entry { promise: Promise<Record<string, unknown>>; turnId: string; cancelled: boolean; runId?: string }

/**
 * Runs the one allowed function with the guarantees the plan asks for: validated arguments, de-duplication by provider
 * call id AND by logical turn (the same spoken request never reaches the agent twice), a hard timeout, structured errors
 * and cancellation. `execute` does the real work; this class owns the bookkeeping so it can be unit tested alone.
 */
export class FunctionCallHandler {
  private readonly byCallId = new Map<string, Entry>();
  private readonly byTurn = new Map<string, Entry>();
  duplicates = 0;

  constructor(
    private readonly execute: (turnId: string, request: string, onRun: (runId: string) => void) => Promise<Record<string, unknown>>,
    private readonly timeoutMs: number,
    private readonly hooks: { onDuplicate?: () => void } = {},
  ) {}

  /** Returns the response to send to the provider, or null when there is nothing to send (cancelled, or a redelivered call id). */
  async handle(call: ProviderFunctionCall, ctx: CallContext): Promise<FunctionResponse | null> {
    const base = { id: call.id, name: call.name };
    if (call.name !== SUPPORT_TOOL_NAME) return { ...base, response: { success: false, error: "UNSUPPORTED_TOOL" } };

    // The same provider call id arriving again is a redelivery: it is answered once, by the first delivery.
    if (this.byCallId.has(call.id)) {
      this.duplicates += 1;
      this.hooks.onDuplicate?.();
      return null;
    }
    // A different call id for a turn that is already being handled shares that execution (and still gets its own response).
    const sameTurn = this.byTurn.get(ctx.turnId);
    if (sameTurn) {
      this.duplicates += 1;
      this.hooks.onDuplicate?.();
      this.byCallId.set(call.id, sameTurn);
      const response = await sameTurn.promise;
      return sameTurn.cancelled ? null : { ...base, response };
    }

    const parsed = supportRequestSchema.safeParse(call.args);
    if (!parsed.success) return { ...base, response: { success: false, error: "INVALID_ARGUMENTS", spokenResponse: "I didn't catch that request clearly. Could you say it again?" } };

    const entry: Entry = { turnId: ctx.turnId, cancelled: false } as Entry;
    entry.promise = this.run(entry, ctx.turnId, parsed.data.request);
    this.byCallId.set(call.id, entry);
    this.byTurn.set(ctx.turnId, entry);
    const response = await entry.promise;
    return entry.cancelled ? null : { ...base, response };
  }

  private async run(entry: Entry, turnId: string, request: string): Promise<Record<string, unknown>> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.execute(turnId, request, (runId) => { entry.runId = runId; }),
        new Promise<Record<string, unknown>>((resolve) => {
          timer = setTimeout(() => resolve({ success: false, error: "TIMEOUT", spokenResponse: "That is taking longer than expected. I'll keep working on it and the answer will appear in the chat." }), this.timeoutMs);
        }),
      ]);
    } catch {
      return { success: false, error: "INTERNAL", spokenResponse: "Sorry, something went wrong on our side. Please try again in a moment." };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Marks calls cancelled (provider toolCallCancellation or barge-in). Their results are discarded, never sent. */
  cancel(ids: string[]): Array<{ id: string; turnId: string; runId?: string }> {
    const out: Array<{ id: string; turnId: string; runId?: string }> = [];
    for (const id of ids) {
      const e = this.byCallId.get(id);
      if (e && !e.cancelled) {
        e.cancelled = true;
        out.push(e.runId ? { id, turnId: e.turnId, runId: e.runId } : { id, turnId: e.turnId });
      }
    }
    return out;
  }

  /** Cancels everything still in flight for a turn. */
  cancelTurn(turnId: string): { runId?: string } | null {
    const e = this.byTurn.get(turnId);
    if (!e || e.cancelled) return null;
    e.cancelled = true;
    return e.runId ? { runId: e.runId } : {};
  }

  hasCall(turnId: string): boolean {
    return this.byTurn.has(turnId);
  }

  runIdFor(turnId: string): string | undefined {
    return this.byTurn.get(turnId)?.runId;
  }
}
