import { Inject, Injectable } from "@nestjs/common";
import { toEnvelope, type SseEnvelope } from "@support-ai/contracts";
import { map, type Observable } from "rxjs";
import { AgentEventsService } from "../agent/events/agent-events.service.js";

/** Live events for a session, in wire form. */
@Injectable()
export class EventPublisherService {
  constructor(@Inject(AgentEventsService) private readonly events: AgentEventsService) {}

  live(sessionId: string): Observable<SseEnvelope> {
    return this.events.ofSession(sessionId).pipe(map(toEnvelope));
  }
}
