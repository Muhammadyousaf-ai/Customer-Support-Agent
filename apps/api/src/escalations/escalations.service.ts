import { Inject, Injectable, Optional } from "@nestjs/common";
import type pg from "pg";
import { AuditService } from "../audit/audit.service.js";
import { PG_POOL } from "../database/tokens.js";
import { SubscriptionsService } from "../subscriptions/subscriptions.service.js";
import { TicketsService } from "../tickets/tickets.service.js";
import type { ToolExecutionContext } from "../tools/registry/tool-definition.interface.js";

export const ESCALATION_REASONS = [
  "MANUAL_APPROVAL_REQUIRED", "POLICY_NOT_FOUND", "LOW_CONFIDENCE", "IDENTITY_FAILED", "CUSTOMER_REQUESTED", "TOOL_FAILURE", "OTHER",
] as const;
export const ESCALATION_CATEGORIES = ["billing", "refund", "account", "technical", "other"] as const;
export const ESCALATION_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export interface EscalationInput {
  reason: (typeof ESCALATION_REASONS)[number];
  category: (typeof ESCALATION_CATEGORIES)[number];
  priority?: (typeof ESCALATION_PRIORITIES)[number];
  summary: string;
  inquiry?: string;
  policyReferences?: Array<{ document: string; heading: string }>;
}

export interface TicketRecord {
  ticketId: string;
  customerId: string | null;
  category: string;
  priority: string;
  reason: string;
  summary: string;
  status: string;
  completedToolExecutions: Array<{ tool: string; status: string }>;
  /** True when an existing ticket for the same idempotency key was returned. */
  replayed: boolean;
}

@Injectable()
export class EscalationsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(SubscriptionsService) private readonly subscriptions: SubscriptionsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(TicketsService) private readonly tickets?: TicketsService,
  ) {}

  /** Persistent, structured ticket. Idempotent: a retry returns the ticket created by the first attempt. */
  async create(ctx: ToolExecutionContext, input: EscalationInput): Promise<TicketRecord> {
    const key = ctx.idempotencyKey!;
    const existing = await this.findByKey(key);
    if (existing) return { ...existing, replayed: true };

    // Priority floor comes from trusted records, not from the LLM's guess.
    const subscription = ctx.customerId ? await this.subscriptions.getForCustomer(ctx.customerId) : null;
    const priority = input.priority ?? (subscription?.tier === "enterprise" ? "high" : "normal");
    const { rows: executed } = await this.pool.query<{ tool: string; status: string }>(
      "select tool, status from tool_executions where run_id = $1 order by created_at", [ctx.runId],
    );

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query(
        `insert into escalation_tickets
           (session_id, run_id, customer_id, category, priority, reason, summary, inquiry, policy_references, completed_tool_executions, idempotency_key)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
         on conflict (idempotency_key) do nothing returning id`,
        [ctx.sessionId, ctx.runId, ctx.customerId ?? null, input.category, priority, input.reason, input.summary, input.inquiry ?? null,
         JSON.stringify(input.policyReferences ?? []), JSON.stringify(executed), key],
      );
      if (rows[0]) {
        // Phase 9: this is now the support ticket. Link it to the account, describe it, and hand the conversation to humans.
        await client.query(
          `update escalation_tickets t set user_id = s.user_id, subject = left($2, 120), ai_summary = $3,
             source = case when exists (select 1 from agent_runs r where r.id = t.run_id and r.mode = 'voice') then 'ai_voice' else 'ai_chat' end
           from sessions s where s.id = t.session_id and t.id = $1`, [rows[0].id, input.summary, input.summary],
        );
        await client.query("insert into ticket_status_history (ticket_id, from_status, to_status, note) values ($1, null, 'open', $2)", [rows[0].id, `AI escalation: ${input.reason}`]);
        await client.query("update sessions set handover_mode = 'WAITING_FOR_STAFF' where id = $1", [ctx.sessionId]);
        await this.audit.log({ sessionId: ctx.sessionId, customerId: ctx.customerId, actor: "agent", action: "escalation.created", entityType: "ticket", entityId: rows[0].id, newValue: { reason: input.reason, priority } }, client);
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
    const ticket = await this.findByKey(key);
    if (ticket) void this.tickets?.afterEscalation(ticket.ticketId); // notify the team and try automatic assignment; never blocks or fails the AI run
    return { ...ticket!, replayed: false };
  }

  private async findByKey(key: string): Promise<TicketRecord | null> {
    const { rows } = await this.pool.query(
      "select id, customer_id, category, priority, reason, summary, status, completed_tool_executions from escalation_tickets where idempotency_key = $1", [key],
    );
    const r = rows[0];
    return r ? { ticketId: r.id, customerId: r.customer_id, category: r.category, priority: r.priority, reason: r.reason, summary: r.summary, status: r.status, completedToolExecutions: r.completed_tool_executions, replayed: false } : null;
  }
}
