export interface ModelPricing {
  provider: "openai";
  model: string;
  currency: "USD";
  inputTextPerMillion?: number;
  outputTextPerMillion?: number;
  inputAudioPerMillion?: number;
  outputAudioPerMillion?: number;
  cachedInputPerMillion?: number;
  embeddingPerMillion?: number;
  /** ISO date (inclusive). */
  effectiveFrom: string;
  /** ISO date (exclusive). */
  effectiveUntil?: string;
  sourceUrl: string;
  /** When someone last compared this entry with the official page. */
  verifiedOn: string;
  note?: string;
}

/**
 * Versioned OpenAI price list (USD per 1M tokens). Never edit a past entry to change a price: add a new one with a later
 * `effectiveFrom`, so historical estimates stay reproducible. Unlisted models have NO price (unavailable, never zero).
 * Usage reports the dated snapshot name, so aliases and snapshots are both listed.
 */
const SOURCE = "https://openai.com/api/pricing/";
const VERIFIED = "2026-11-25";
const FROM = "2026-11-25";
const o = (models: string[], e: Omit<ModelPricing, "provider" | "currency" | "sourceUrl" | "verifiedOn" | "model" | "effectiveFrom">): ModelPricing[] =>
  models.map((model) => ({ provider: "openai", currency: "USD", sourceUrl: SOURCE, verifiedOn: VERIFIED, model, effectiveFrom: FROM, ...e }));

export const OPENAI_PRICING: ModelPricing[] = [
  ...o(["gpt-4.1-mini", "gpt-4.1-mini-2025-04-14"], { inputTextPerMillion: 0.4, cachedInputPerMillion: 0.1, outputTextPerMillion: 1.6 }),
  ...o(["gpt-realtime-mini", "gpt-realtime-mini-2025-12-15"], { inputTextPerMillion: 0.6, cachedInputPerMillion: 0.06, outputTextPerMillion: 2.4, inputAudioPerMillion: 10, outputAudioPerMillion: 20 }),
  ...o(["text-embedding-3-small"], { embeddingPerMillion: 0.02 }),
];
