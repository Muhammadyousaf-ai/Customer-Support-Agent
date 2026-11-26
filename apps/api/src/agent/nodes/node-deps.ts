import type { AgentEventPayloads, AgentEventType } from "@support-ai/contracts";
import { ContractsService } from "../../contracts/contracts.service.js";
import { CustomersService } from "../../customers/customers.service.js";
import { SessionsService } from "../../sessions/sessions.service.js";
import { SubscriptionsService } from "../../subscriptions/subscriptions.service.js";
import { ToolRegistry } from "../../tools/registry/tool-registry.service.js";
import { ToolExecutor } from "../../tools/registry/tool-executor.service.js";
import type { AgentConfig } from "../config/agent.config.js";
import { AgentEventsService } from "../events/agent-events.service.js";
import { AgentTraceService } from "../events/agent-trace.service.js";
import { EvidenceChecker } from "../guardrails/evidence-checker.js";
import { SecretVault } from "../guardrails/secret-vault.js";
import { ConversationMemoryService } from "../memory/conversation-memory.service.js";
import { PendingActionsService } from "../memory/pending-actions.service.js";
import { SummarizationService } from "../memory/summarization.service.js";
import type { LlmProvider, LlmToolDef } from "../providers/llm-provider.interface.js";
import { RunRegistry, RunsService } from "../runs/runs.service.js";
import type { AgentStateType, TrustedContext } from "../state/agent-state.js";

/** Everything the graph nodes need. Nodes are plain functions over (state, deps), so each is testable alone. */
export interface AgentDeps {
  cfg: AgentConfig;
  llm: LlmProvider;
  tools: ToolExecutor;
  registry: ToolRegistry;
  events: AgentEventsService;
  trace: AgentTraceService;
  memory: ConversationMemoryService;
  pending: PendingActionsService;
  runRegistry: RunRegistry;
  runs: RunsService;
  vault: SecretVault;
  evidence: EvidenceChecker;
  sessions: SessionsService;
  subscriptions: SubscriptionsService;
  contracts: ContractsService;
  customers: CustomersService;
  summarizer: SummarizationService;
}

export const emit = <K extends AgentEventType>(d: AgentDeps, s: Pick<AgentStateType, "sessionId" | "runId">, type: K, data: K extends keyof AgentEventPayloads ? AgentEventPayloads[K] : unknown) =>
  d.events.emit(type, s.sessionId, s.runId, data);

/** Tool definitions the model sees: the Phase 3 registry, as function schemas. */
export function llmToolDefs(registry: ToolRegistry): LlmToolDef[] {
  return registry.describe().map((t) => {
    const { $schema: _ignored, ...parameters } = t.parameters as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });
}

/** Facts the model may rely on, always re-read from the backend (never carried over from an earlier turn). */
export async function loadTrusted(d: AgentDeps, customerId: string): Promise<TrustedContext> {
  const [sub, contract] = await Promise.all([d.subscriptions.getForCustomer(customerId), d.contracts.getForCustomer(customerId)]);
  return {
    customerId,
    tier: sub?.tier,
    billingPeriod: sub?.billingPeriod,
    monthlyPriceCents: sub?.monthlyPriceCents,
    subscriptionStatus: sub?.status,
    contractType: contract?.type,
    contractStatus: contract?.status,
  };
}

export const MAX_TOOL_MESSAGE_CHARS = 6000;

/** JSON for a tool message, capped so one verbose result cannot blow the context window. */
export function toolPayload(payload: unknown): string {
  const text = JSON.stringify(payload);
  return text.length > MAX_TOOL_MESSAGE_CHARS ? `${text.slice(0, MAX_TOOL_MESSAGE_CHARS)}…[truncated]` : text;
}

export const toolMessage = (toolCallId: string, payload: unknown) => ({ role: "tool" as const, toolCallId, content: toolPayload(payload) });
export const systemNote = (content: string) => ({ role: "system" as const, content });

export const lastUserText = (s: Pick<AgentStateType, "messages">): string => [...s.messages].reverse().find((m) => m.role === "user")?.content ?? "";
