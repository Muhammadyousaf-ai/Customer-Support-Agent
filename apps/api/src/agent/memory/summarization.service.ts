import { Inject, Injectable, Logger } from "@nestjs/common";
import { AGENT_CONFIG, type AgentConfig } from "../config/agent.config.js";
import { SUMMARY_SYSTEM, summaryPrompt } from "../prompts/conversation-summary.prompt.js";
import { LLM_PROVIDER, type LlmProvider } from "../providers/llm-provider.interface.js";
import { ConversationMemoryService } from "./conversation-memory.service.js";

/** Folds old messages into a short summary so long conversations do not grow the prompt without bound. */
@Injectable()
export class SummarizationService {
  private readonly logger = new Logger(SummarizationService.name);

  constructor(
    @Inject(ConversationMemoryService) private readonly memory: ConversationMemoryService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(AGENT_CONFIG) private readonly cfg: AgentConfig,
  ) {}

  /**
   * Best effort and never on the critical path: a failure just means the window keeps sliding without a summary.
   * Returns the token usage so the caller can account for it.
   */
  async maybeSummarize(sessionId: string): Promise<{ inputTokens: number; outputTokens: number } | null> {
    if (!this.llm.configured) return null;
    try {
      const { summary, throughId } = await this.memory.getSummary(sessionId);
      const older = await this.memory.unsummarizedOlderThanWindow(sessionId, this.cfg.historyWindow, throughId);
      if (older.length < Math.max(6, Math.floor(this.cfg.historyWindow / 2))) return null;
      const transcript = older.map((m) => `${m.role}: ${m.content}`).join("\n");
      const res = await this.llm.complete({ purpose: "summary", system: SUMMARY_SYSTEM, messages: [{ role: "user", content: summaryPrompt(summary, transcript) }], tools: [], toolChoice: "none" });
      const text = res.content?.trim();
      if (!text) return null;
      await this.memory.setSummary(sessionId, text, older[older.length - 1]!.id);
      return res.usage;
    } catch (err) {
      this.logger.warn(`summarisation skipped: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
