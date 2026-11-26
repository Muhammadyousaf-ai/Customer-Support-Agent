import { Inject, Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { AGENT_CONFIG, type AgentConfig } from "../config/agent.config.js";
import { EVIDENCE_VERDICT_TOOL, EVIDENCE_VERIFICATION_SYSTEM, evidencePrompt } from "../prompts/evidence-verification.prompt.js";
import { LLM_PROVIDER, type LlmProvider } from "../providers/llm-provider.interface.js";

export interface EvidenceVerdict {
  supported: boolean;
  unsupportedClaims: string[];
  inputTokens: number;
  outputTokens: number;
  /** False when the check could not run (no model, or it failed). The deterministic checks still applied. */
  ran: boolean;
}

const verdictSchema = z.object({ supported: z.boolean(), unsupportedClaims: z.array(z.string()).default([]) });

/**
 * Optional second opinion from the model on whether an answer is supported by its evidence. It can only make the
 * guardrail STRICTER: a failed or unavailable check never lets an answer through that the deterministic checks
 * rejected, and an "unsupported" verdict blocks release.
 */
@Injectable()
export class EvidenceChecker {
  private readonly logger = new Logger(EvidenceChecker.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(AGENT_CONFIG) private readonly cfg: AgentConfig,
  ) {}

  get enabled(): boolean {
    return this.cfg.llmEvidenceCheck && this.llm.configured;
  }

  async check(answer: string, evidence: string, signal?: AbortSignal): Promise<EvidenceVerdict> {
    const none: EvidenceVerdict = { supported: true, unsupportedClaims: [], inputTokens: 0, outputTokens: 0, ran: false };
    if (!this.enabled) return none;
    try {
      const res = await this.llm.complete({
        purpose: "evidence_check",
        system: EVIDENCE_VERIFICATION_SYSTEM,
        messages: [{ role: "user", content: evidencePrompt(answer, evidence) }],
        tools: [{ ...EVIDENCE_VERDICT_TOOL, parameters: EVIDENCE_VERDICT_TOOL.parameters as unknown as Record<string, unknown> }],
        toolChoice: "required",
        signal,
      });
      const args = res.toolCalls[0]?.arguments;
      const parsed = verdictSchema.safeParse(args ? JSON.parse(args) : null);
      if (!parsed.success) return { ...none, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens };
      return { ...parsed.data, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, ran: true };
    } catch (err) {
      this.logger.warn(`evidence check unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return none;
    }
  }
}
