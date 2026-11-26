import { OPENAI_PRICING, type ModelPricing } from "./openai-pricing.config.js";
import type { NormalizedUsage } from "../usage/usage-normalizer.js";

export type CostEstimate =
  | { status: "ok"; usd: number; pricingVersion: string; snapshot: ModelPricing; parts: Record<string, number> }
  | { status: "unavailable"; reason: string };

const day = (d: Date) => d.toISOString().slice(0, 10);
export const versionOf = (p: ModelPricing) => `${p.model}@${p.effectiveFrom}`;

/** Looks up the price that applied on a given day. Unknown model or a date before the first entry: no price. */
export class PricingRegistry {
  constructor(private readonly entries: ModelPricing[] = OPENAI_PRICING) {}

  all(): ModelPricing[] {
    return [...this.entries];
  }

  priceFor(model: string, at: Date = new Date()): ModelPricing | null {
    const d = day(at);
    return this.entries.find((p) => p.model === model && p.effectiveFrom <= d && (!p.effectiveUntil || d < p.effectiveUntil)) ?? null;
  }

  /**
   * C = sum(tokens_i x price_i) / 1,000,000, per billing bucket. A bucket with tokens but no configured rate makes the
   * whole estimate unavailable: a partial sum would silently understate the cost.
   */
  estimate(model: string, u: NormalizedUsage, at: Date = new Date(), extra: { embeddingTokens?: number } = {}): CostEstimate {
    if (u.usageSource === "unavailable" && !extra.embeddingTokens) return { status: "unavailable", reason: "The provider reported no usage for this call." };
    const p = this.priceFor(model, at);
    if (!p) return { status: "unavailable", reason: `No pricing configured for ${model} on ${day(at)}.` };
    const buckets: Array<[string, number, number | undefined]> = [
      ["input_text", u.inputTextTokens + u.toolInputTokens, p.inputTextPerMillion],
      ["cached_input", u.cachedInputTokens, p.cachedInputPerMillion ?? p.inputTextPerMillion],
      ["output_text", u.outputTextTokens, p.outputTextPerMillion],
      ["input_audio", u.inputAudioTokens, p.inputAudioPerMillion],
      ["output_audio", u.outputAudioTokens, p.outputAudioPerMillion],
      ["embedding", extra.embeddingTokens ?? 0, p.embeddingPerMillion],
    ];
    const parts: Record<string, number> = {};
    let usd = 0;
    for (const [name, tokens, rate] of buckets) {
      if (!tokens) continue;
      if (rate === undefined) return { status: "unavailable", reason: `${model} has no ${name.replace("_", " ")} price configured.` };
      parts[name] = (tokens * rate) / 1_000_000;
      usd += parts[name]!;
    }
    return { status: "ok", usd, pricingVersion: versionOf(p), snapshot: p, parts };
  }
}

export const pricingRegistry = new PricingRegistry();
/** Costs are stored as fixed-precision strings so JSON never turns 0.004440 into 0.00444 or loses precision. */
export const formatUsd = (n: number): string => n.toFixed(6);
