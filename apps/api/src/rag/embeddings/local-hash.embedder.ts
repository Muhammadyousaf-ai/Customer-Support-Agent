import { EMBEDDING_DIMENSIONS } from "../rag.constants.js";
import { contentTokens } from "../text/text-utils.js";
import type { Embedder, EmbedResult } from "../types/rag.types.js";

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic offline embedder: signed feature hashing of normalised unigrams and bigrams into 1536 dims.
 * It is lexical (with a small synonym map), NOT semantic. Exists so the pipeline, tests and demos run without
 * an API key; production quality needs the OpenAI embedder.
 */
export class LocalHashEmbedder implements Embedder {
  readonly name = "local" as const;
  readonly model = "local-hash-1536-v1";

  embedOne(text: string): number[] {
    const tokens = contentTokens(text);
    if (!tokens.length) tokens.push("__empty__");
    const counts = new Map<string, number>();
    for (let i = 0; i < tokens.length; i++) {
      counts.set(tokens[i]!, (counts.get(tokens[i]!) ?? 0) + 1);
      if (i > 0) {
        const bigram = `${tokens[i - 1]}_${tokens[i]}`;
        counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
      }
    }
    const v = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
    for (const [feature, c] of counts) {
      const h = fnv1a(feature);
      v[h % EMBEDDING_DIMENSIONS]! += (h & 0x80000000 ? -1 : 1) * (1 + Math.log(c));
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    return { vectors: texts.map((t) => this.embedOne(t)), tokens: 0 };
  }
}
