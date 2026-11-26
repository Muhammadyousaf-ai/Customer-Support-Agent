import { Module } from "@nestjs/common";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";
import { AdminGuard } from "../rag/admin.guard.js";
import { ContractsService } from "../contracts/contracts.service.js";
import { CustomersService } from "../customers/customers.service.js";
import { SessionAuthService } from "../sessions/session-auth.service.js";
import { SessionsService } from "../sessions/sessions.service.js";
import { SubscriptionsService } from "../subscriptions/subscriptions.service.js";
import { ToolExecutor } from "../tools/registry/tool-executor.service.js";
import { ToolRegistry } from "../tools/registry/tool-registry.service.js";
import { ToolsModule } from "../tools/tools.module.js";
import { AgentController } from "./agent.controller.js";
import { AgentService } from "./agent.service.js";
import { AGENT_CONFIG, resolveAgentConfig, type AgentConfig } from "./config/agent.config.js";
import { AgentEventsService } from "./events/agent-events.service.js";
import { AgentTraceService } from "./events/agent-trace.service.js";
import { EvidenceChecker } from "./guardrails/evidence-checker.js";
import { SecretVault } from "./guardrails/secret-vault.js";
import { CheckpointerService } from "./memory/checkpointer.service.js";
import { ConversationMemoryService } from "./memory/conversation-memory.service.js";
import { PendingActionsService } from "./memory/pending-actions.service.js";
import { SummarizationService } from "./memory/summarization.service.js";
import type { AgentDeps } from "./nodes/node-deps.js";
import { LLM_PROVIDER, type LlmProvider } from "./providers/llm-provider.interface.js";
import { E2eScenarioProvider } from "./providers/e2e-scenario.provider.js";
import { OpenAiChatProvider } from "./providers/openai-chat.provider.js";
import { UnconfiguredLlmProvider } from "./providers/unconfigured-llm.provider.js";
import { RunRegistry, RunsService } from "./runs/runs.service.js";
import { InstrumentedLlmProvider } from "../observability/instrumentation/instrumented-llm.provider.js";

/** The orchestrator imports the tool module (which already imports RAG) instead of duplicating either. */
@Module({
  imports: [ToolsModule],
  controllers: [AgentController],
  providers: [
    { provide: AGENT_CONFIG, useFactory: (env: Env) => resolveAgentConfig(env), inject: [ENV] },
    {
      provide: LLM_PROVIDER,
      useFactory: (env: Env, cfg: AgentConfig): LlmProvider => {
        if (env.AGENT_LLM === "e2e") {
          if (env.NODE_ENV === "production") throw new Error("AGENT_LLM=e2e is a development test double and cannot run in production");
          return new InstrumentedLlmProvider(new E2eScenarioProvider(env.E2E_LLM_DELAY_MS), "e2e-scenario");
        }
        // Every model call (decision, evidence check, summary) is traced, priced and persisted by this wrapper.
        return new InstrumentedLlmProvider(env.OPENAI_API_KEY ? new OpenAiChatProvider(cfg.model, env.OPENAI_API_KEY, cfg.llmTimeoutMs, cfg.llmMaxRetries) : new UnconfiguredLlmProvider(cfg.model));
      },
      inject: [ENV, AGENT_CONFIG],
    },
    SecretVault, EvidenceChecker, AgentEventsService, AgentTraceService, ConversationMemoryService, PendingActionsService,
    SummarizationService, CheckpointerService, RunsService, RunRegistry, AdminGuard, SessionAuthService,
    {
      provide: "AGENT_DEPS",
      useFactory: (
        cfg: AgentConfig, llm: LlmProvider, tools: ToolExecutor, registry: ToolRegistry, events: AgentEventsService, trace: AgentTraceService,
        memory: ConversationMemoryService, pending: PendingActionsService, runRegistry: RunRegistry, runs: RunsService, vault: SecretVault,
        evidence: EvidenceChecker, sessions: SessionsService, subscriptions: SubscriptionsService, contracts: ContractsService,
        customers: CustomersService, summarizer: SummarizationService,
      ): AgentDeps => ({ cfg, llm, tools, registry, events, trace, memory, pending, runRegistry, runs, vault, evidence, sessions, subscriptions, contracts, customers, summarizer }),
      inject: [
        AGENT_CONFIG, LLM_PROVIDER, ToolExecutor, ToolRegistry, AgentEventsService, AgentTraceService, ConversationMemoryService, PendingActionsService,
        RunRegistry, RunsService, SecretVault, EvidenceChecker, SessionsService, SubscriptionsService, ContractsService, CustomersService, SummarizationService,
      ],
    },
    AgentService,
  ],
  exports: [AgentService, AgentEventsService, SessionAuthService],
})
export class AgentModule {}
