import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/** Who a piece of telemetry belongs to. Carried implicitly through async calls, so deep code never passes ids around. */
export interface TraceContext {
  traceId: string;
  sessionId: string;
  runId: string;
  turnId?: string;
  mode: "chat" | "voice";
  voiceSessionId?: string;
  /** 1 for the first execution segment of a run, 2+ after a confirmation pause. */
  segment: number;
}

const als = new AsyncLocalStorage<TraceContext>();

export const currentTrace = (): TraceContext | undefined => als.getStore();
export const runWithTrace = <T>(ctx: TraceContext, fn: () => T): T => als.run(ctx, fn);

/** A run (including every segment after a pause) is one trace. Deterministic, so a resumed run joins its original trace. */
export const traceIdFor = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 32);
