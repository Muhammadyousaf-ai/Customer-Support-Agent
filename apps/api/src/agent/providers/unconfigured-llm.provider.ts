import { LlmError, type LlmProvider, type LlmResponse } from "./llm-provider.interface.js";

/** Used when no OPENAI_API_KEY is set. Every call fails cleanly, so the agent's recovery path runs (escalation). */
export class UnconfiguredLlmProvider implements LlmProvider {
  readonly name = "none";
  readonly configured = false;
  constructor(readonly model: string) {}
  async complete(): Promise<LlmResponse> {
    throw new LlmError("LLM_NOT_CONFIGURED", "No language model is configured (set OPENAI_API_KEY).");
  }
}
