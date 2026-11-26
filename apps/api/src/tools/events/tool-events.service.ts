import { Injectable } from "@nestjs/common";
import type { AgentEvent, ToolEventData } from "@support-ai/contracts";
import { Subject, filter } from "rxjs";

type ToolEventType = "tool.started" | "tool.completed" | "tool.failed";
export type ToolEvent = AgentEvent<ToolEventData> & { type: ToolEventType };

/** In-process event stream. Phase 5 forwards it over SSE; Phase 7 persists it as traces. */
@Injectable()
export class ToolEventsService {
  private readonly subject = new Subject<ToolEvent>();
  private readonly seq = new Map<string, number>();
  readonly events$ = this.subject.asObservable();

  emit(type: ToolEventType, sessionId: string, runId: string, data: ToolEventData): void {
    const seq = (this.seq.get(runId) ?? 0) + 1;
    this.seq.set(runId, seq);
    this.subject.next({ type, sessionId, runId, seq, ts: new Date().toISOString(), data });
  }

  ofRun(runId: string) {
    return this.events$.pipe(filter((e) => e.runId === runId));
  }
}
