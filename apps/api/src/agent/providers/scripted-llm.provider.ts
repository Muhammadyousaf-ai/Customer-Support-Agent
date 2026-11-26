import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse, type LlmToolCall } from "./llm-provider.interface.js";

export type ScriptedReply = Partial<Omit<LlmResponse, "toolCalls">> & { toolCalls?: LlmToolCall[]; throws?: LlmError };
export type ScriptedResponder = (request: LlmRequest, callIndex: number) => ScriptedReply | Promise<ScriptedReply>;

let seq = 0;
/** Builds a function-calling reply. `args` is serialised exactly as a real model would return it. */
export const callTool = (name: string, args: unknown = {}, text = ""): ScriptedReply => ({
  content: text || null,
  toolCalls: [{ id: `call_${++seq}`, name, arguments: typeof args === "string" ? args : JSON.stringify(args) }],
});
export const respond = (response: string, sourceIds: string[] = []) => callTool("respond_to_customer", { response, sourceIds });
export const ask = (question: string, requiredFields: string[] = []) => callTool("ask_customer_for_info", { question, requiredFields });
export const escalateTo = (reason: string, category = "other", summary = reason) => callTool("escalate_to_human", { reason, category, summary });

/**
 * Deterministic stand-in for a model, for tests and offline demos. It plays back a script, so it exercises the
 * orchestrator and guardrails but says NOTHING about real model decision quality.
 */
export class ScriptedLlmProvider implements LlmProvider {
  readonly name = "scripted";
  readonly model = "scripted-1";
  readonly configured = true;
  readonly decisionRequests: LlmRequest[] = [];
  readonly allRequests: LlmRequest[] = [];
  /** Overrides for non-decision calls; by default evidence checks pass and summaries are canned. */
  auxiliary: Partial<Record<"evidence_check" | "summary", ScriptedResponder>> = {};

  private script: ScriptedResponder | ScriptedResponder[];

  constructor(script: ScriptedResponder | ScriptedResponder[] = []) {
    this.script = script;
  }

  /** Installs a new script and clears recorded calls, so one provider can serve many tests. */
  use(script: ScriptedResponder | ScriptedResponder[]): this {
    this.script = script;
    this.decisionRequests.length = 0;
    this.allRequests.length = 0;
    this.auxiliary = {};
    return this;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.allRequests.push(req);
    let reply: ScriptedReply;
    if (req.purpose === "decision") {
      const i = this.decisionRequests.length;
      this.decisionRequests.push(req);
      const responder = Array.isArray(this.script) ? this.script[Math.min(i, this.script.length - 1)] : this.script;
      if (!responder) throw new Error("ScriptedLlmProvider: empty script");
      reply = await responder(req, i);
    } else {
      const aux = this.auxiliary[req.purpose];
      reply = aux
        ? await aux(req, this.allRequests.length)
        : req.purpose === "evidence_check"
          ? callTool("report_verdict", { supported: true, unsupportedClaims: [] })
          : { content: "Earlier conversation summarised." };
    }
    if (reply.throws) throw reply.throws;
    return {
      content: reply.content ?? null,
      toolCalls: reply.toolCalls ?? [],
      usage: reply.usage ?? { inputTokens: 100, outputTokens: 20 },
      latencyMs: reply.latencyMs ?? 1,
      model: reply.model ?? this.model,
    };
  }
}
