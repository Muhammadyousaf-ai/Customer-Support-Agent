import { LlmError, type LlmMessage, type LlmProvider, type LlmRequest, type LlmResponse } from "./llm-provider.interface.js";

/**
 * DEVELOPMENT / E2E ONLY (AGENT_LLM=e2e, refused when NODE_ENV=production).
 * A rule-based stand-in for a model so browser tests can drive the REAL graph, tools, guardrails and confirmation
 * flow without an API key. It is intentionally a fixed script keyed on the customer's wording: it demonstrates the
 * product end to end and says nothing about how a real model decides.
 */
export class E2eScenarioProvider implements LlmProvider {
  readonly name = "e2e-scenario";
  readonly model = "e2e-scenario";
  readonly configured = true;

  constructor(private readonly delayMs = 250) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (req.purpose !== "decision") return this.reply(null, [{ name: "report_verdict", args: { supported: true, unsupportedClaims: [] } }]);
    const turn = this.currentTurn(req.messages);
    const user = turn.user.toLowerCase();
    await this.sleep(/\bslow\b/.test(user) ? 8000 : this.delayMs, req.signal);

    const called = (n: string) => turn.calls.includes(n);
    const result = (n: string) => turn.results[n];
    const verified = req.system.includes("verified as customer");
    const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(turn.user)?.[0];
    const code = /\[CODE-\d+\]/.exec(turn.user)?.[0];
    const tool = (name: string, args: unknown = {}) => this.reply(null, [{ name, args }]);
    const say = (response: string, sourceIds: string[] = []) => tool("respond_to_customer", { response, sourceIds });
    const needLogin = () =>
      email && code && !called("verify_identity")
        ? tool("verify_identity", { email, verificationCode: code })
        : tool("ask_customer_for_info", { question: "I can help with that. What is the email on your account and your 6 digit verification code?", requiredFields: ["email", "verificationCode"] });
    const declined = Object.values(turn.errors).some((e) => e === "CUSTOMER_DECLINED");
    const firstSource = (turn.results.search_knowledge_base as { sources?: Array<{ chunkId: string }> } | undefined)?.sources?.[0]?.chunkId;

    if (/crypto|weather|poem|lifetime|transfer my/.test(user)) {
      return tool("escalate_to_human", { reason: "Request is outside supported topics", category: "other", summary: turn.user.slice(0, 200) });
    }
    if (/change my account\b/.test(user) && !verified) {
      return tool("ask_customer_for_info", { question: "Which detail would you like to change (display name, timezone or language), and what should it become?", requiredFields: ["field", "value"] });
    }

    if (/refund|money back|charged|reverse/.test(user) && !/policy/.test(user)) {
      if (declined) return say("No problem, I haven't made any changes.");
      if (!verified && !called("verify_identity")) return needLogin();
      if (turn.errors.VERIFICATION_FAILED || (turn.errors.IDENTITY_REQUIRED && !verified)) {
        return tool("ask_customer_for_info", { question: "I couldn't verify you. Please check your email and verification code and send them again.", requiredFields: ["email", "verificationCode"] });
      }
      if (!called("get_payment_history")) return tool("get_payment_history", {});
      if (!called("search_knowledge_base")) return tool("search_knowledge_base", { query: "refund policy for a recent monthly payment" });
      const payments = (result("get_payment_history") as { payments?: Array<{ paymentId: string; refundableCents: number }> } | undefined)?.payments ?? [];
      const target = payments.find((p) => p.refundableCents > 0);
      if (!called("issue_refund") && target) return tool("issue_refund", { paymentId: target.paymentId });
      const refund = result("issue_refund") as { refundId?: string; amountCents?: number } | undefined;
      if (refund?.refundId) {
        return say(`Your refund ${refund.refundId} of $${(refund.amountCents ?? 0) / 100} has been processed. Monthly subscriptions can be refunded within seven days.`, firstSource ? [firstSource] : []);
      }
      if (turn.errors.ACCESS_DENIED || turn.errors.REFUND_NOT_ELIGIBLE || turn.errors.MANUAL_APPROVAL_REQUIRED || turn.errors.POLICY_NOT_FOUND) {
        return tool("escalate_to_human", { reason: "Refund needs human approval", category: "refund", summary: "Refund request could not be completed automatically" });
      }
      return say("I couldn't find a payment that can be refunded.");
    }
    if (/\bplan\b|subscription|contract/.test(user) && /\bmy\b/.test(user)) {
      if (!verified && !called("verify_identity")) return needLogin();
      if (!called("get_subscription")) return tool("get_subscription", {});
      const sub = (result("get_subscription") as { subscription?: { tier: string; billingPeriod: string; monthlyPrice: number } } | undefined)?.subscription;
      return say(sub ? `You're on the ${sub.tier} plan, billed ${sub.billingPeriod} at $${sub.monthlyPrice} per month.` : "I couldn't load your subscription right now.");
    }
    if (/policy|plans|price|cost|rate limit|log in|login|cancel/.test(user)) {
      if (!called("search_knowledge_base")) return tool("search_knowledge_base", { query: turn.user.slice(0, 200) });
      return firstSource
        ? say("Monthly subscriptions can be refunded within seven days of the payment.", [firstSource])
        : tool("escalate_to_human", { reason: "No policy found", category: "other", summary: turn.user.slice(0, 200) });
    }
    return say("Hello! How can I help you today?");
  }

  /** The current customer turn: its message, the tools called since, and their parsed results/errors. */
  private currentTurn(messages: LlmMessage[]) {
    let lastUser = -1;
    messages.forEach((m, i) => {
      if (m.role === "user") lastUser = i;
    });
    const names = new Map<string, string>();
    const calls: string[] = [];
    const results: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    for (const m of messages.slice(lastUser + 1)) {
      for (const c of m.toolCalls ?? []) {
        names.set(c.id, c.name);
        calls.push(c.name);
      }
      if (m.role === "tool" && m.toolCallId) {
        try {
          const j = JSON.parse(m.content) as { success?: boolean; data?: unknown; error?: { code: string } };
          const name = names.get(m.toolCallId) ?? "?";
          if (j.success && j.data !== undefined) results[name] = j.data;
          if (j.error?.code) errors[j.error.code] = j.error.code;
        } catch {
          /* not JSON */
        }
      }
    }
    return { user: messages[lastUser]?.content ?? "", calls, results, errors };
  }

  private reply(content: string | null, calls: Array<{ name: string; args: unknown }>): LlmResponse {
    return {
      content,
      toolCalls: calls.map((c, i) => ({ id: `e2e_${Date.now()}_${i}`, name: c.name, arguments: JSON.stringify(c.args) })),
      usage: { inputTokens: 120, outputTokens: 24 },
      latencyMs: this.delayMs,
      model: this.model,
    };
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new LlmError("LLM_ABORTED", "aborted"));
      }, { once: true });
    });
  }
}
