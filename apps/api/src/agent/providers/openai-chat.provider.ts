import { performance } from "node:perf_hooks";
import { OpenAiError, openAiPost } from "../../providers/openai-http.js";
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from "./llm-provider.interface.js";

interface ChatCompletion {
  model: string;
  choices: Array<{ finish_reason?: string; message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string }; extra_content?: unknown }> } }>;
  usage?: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
}

/**
 * OpenAI Chat Completions with native function calling.
 * NOTE: written against the public API but not yet exercised against the live service (no API key was available).
 */
export class OpenAiChatProvider implements LlmProvider {
  readonly name = "openai";
  readonly configured = true;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly maxRetries: number,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const started = performance.now();
    const body = {
      model: this.model,
      temperature: 0,
      max_tokens: 1000,
      messages: [
        { role: "system", content: req.system },
        ...req.messages.map((m) =>
          m.role === "assistant" && m.toolCalls?.length
            ? { role: "assistant", content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments }, ...(c.extraContent ? { extra_content: c.extraContent } : {}) })) }
            : m.role === "tool"
              ? { role: "tool", tool_call_id: m.toolCallId, content: m.content }
              : { role: m.role, content: m.content },
        ),
      ],
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
            tool_choice: req.toolChoice,
            parallel_tool_calls: false,
          }
        : {}),
    };
    try {
      const res = await openAiPost<ChatCompletion>("/chat/completions", body, { apiKey: this.apiKey, timeoutMs: this.timeoutMs, retries: this.maxRetries, signal: req.signal });
      const message = res.choices[0]?.message;
      if (!message) throw new LlmError("LLM_INVALID_RESPONSE", "The model returned no message.");
      return {
        content: message.content,
        toolCalls: (message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments, ...(c.extra_content ? { extraContent: c.extra_content } : {}) })),
        usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
        usageReported: Boolean(res.usage),
        ...(res.choices[0]?.finish_reason ? { finishReason: res.choices[0].finish_reason } : {}),
        ...(res.usage?.prompt_tokens_details?.cached_tokens ? { cachedTokens: res.usage.prompt_tokens_details.cached_tokens } : {}),
        ...(res.usage?.completion_tokens_details?.reasoning_tokens ? { reasoningTokens: res.usage.completion_tokens_details.reasoning_tokens } : {}),
        latencyMs: Math.round(performance.now() - started),
        model: res.model ?? this.model,
      };
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (req.signal?.aborted) throw new LlmError("LLM_ABORTED", "The model call was aborted.");
      if (err instanceof OpenAiError && err.status === 429) throw new LlmError("LLM_RATE_LIMIT", "The model provider is rate limiting requests.", true);
      if (err instanceof OpenAiError && err.status && err.status < 500) throw new LlmError("LLM_INVALID_RESPONSE", `The model request was rejected (${err.status}).`);
      const name = (err as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") throw new LlmError("LLM_TIMEOUT", "The model did not answer in time.", true);
      throw new LlmError("LLM_UNAVAILABLE", "The model provider is unavailable.", true);
    }
  }
}
