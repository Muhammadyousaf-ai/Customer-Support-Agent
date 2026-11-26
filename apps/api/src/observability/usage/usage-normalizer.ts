/**
 * One normalized shape for every model usage report. The important part is NOT double counting:
 *  - cached prompt tokens are a subset of the prompt token count, so billable fresh input = prompt - cached;
 *  - thinking tokens are either already inside the output count (OpenAI `reasoning_tokens`) or reported separately and
 *    billed as output; the adapter says which via `thinkingIncludedInOutput`;
 *  - tool-use prompt tokens, when a provider reports them separately, are billed as input.
 */
export type UsageSource = "provider_reported" | "estimated" | "unavailable";

export interface RawUsage {
  promptTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  thinkingTokens?: number;
  toolUseTokens?: number;
  thinkingIncludedInOutput?: boolean;
  audioInputTokens?: number;
  audioOutputTokens?: number;
}

export interface NormalizedUsage {
  inputTextTokens: number;
  outputTextTokens: number;
  inputAudioTokens: number;
  outputAudioTokens: number;
  cachedInputTokens: number;
  thinkingTokens: number;
  toolInputTokens: number;
  /** Billable total with no overlap counted twice. */
  totalTokens: number;
  usageSource: UsageSource;
}

const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

export function normalizeUsage(raw: RawUsage | null | undefined, source: UsageSource = "provider_reported"): NormalizedUsage {
  if (!raw || source === "unavailable") {
    return { inputTextTokens: 0, outputTextTokens: 0, inputAudioTokens: 0, outputAudioTokens: 0, cachedInputTokens: 0, thinkingTokens: 0, toolInputTokens: 0, totalTokens: 0, usageSource: "unavailable" };
  }
  const prompt = n(raw.promptTokens);
  const cached = Math.min(n(raw.cachedTokens), prompt);
  const audioIn = Math.min(n(raw.audioInputTokens), prompt - cached);
  const toolIn = n(raw.toolUseTokens);
  const thinking = n(raw.thinkingTokens);
  const out = n(raw.outputTokens);
  const audioOut = Math.min(n(raw.audioOutputTokens), out);
  const thinkingExtra = raw.thinkingIncludedInOutput === false ? thinking : 0;
  const inputText = prompt - cached - audioIn;
  const outputText = out - audioOut + thinkingExtra;
  return {
    inputTextTokens: inputText, outputTextTokens: outputText, inputAudioTokens: audioIn, outputAudioTokens: audioOut,
    cachedInputTokens: cached, thinkingTokens: thinking, toolInputTokens: toolIn,
    totalTokens: inputText + audioIn + cached + toolIn + outputText + audioOut, usageSource: source,
  };
}

/** Rough fallback when a provider returns no usage: about 4 characters per token. Always labelled "estimated". */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);
