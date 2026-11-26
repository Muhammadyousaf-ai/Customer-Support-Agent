/**
 * Compares what the speech model actually said (its output transcription) with the verified backend answer.
 * It is a safety net, not a proof: a heuristic that catches the failure modes that matter for a support agent
 * (inventing an outcome the backend did not report, or an amount that is not in the verified text).
 * Prompting alone cannot guarantee grounding; this check plus the audio gate is what enforces it.
 */
export type GroundingVerdict = { ok: true } | { ok: false; reason: string };

interface Claim { name: string; spoken: RegExp; supported: RegExp }

/** A spoken claim is only allowed if the verified text affirms the same thing. */
const CLAIMS: Claim[] = [
  { name: "approval", spoken: /\bapproved\b/gi, supported: /\bapproved\b/gi },
  { name: "completion", spoken: /\b(?:completed|processed|issued|refunded|reimbursed|cancell?ed)\b/gi, supported: /\b(?:completed|processed|issued|refunded|reimbursed|cancell?ed)\b/gi },
  { name: "verification", spoken: /\b(?:verified|authenticated)\b/gi, supported: /\b(?:verified|authenticated)\b/gi },
  { name: "ticket", spoken: /\b(?:created|opened|raised|logged|escalated)\b/gi, supported: /\b(?:created|opened|raised|logged|escalated)\b|\bTKT-\w+|\bticket (?:id|number|reference)\b/gi },
];

const NEGATION = /\b(?:not|never|no|isn'?t|wasn'?t|aren'?t|haven'?t|hasn'?t|can'?t|cannot|couldn'?t|won'?t|unable|failed|fail|without|until|once|if|unless|before|pending|awaiting)\b|n't\b/i;
const WINDOW = 36;

/** True if `text` contains `re` at least once without a negating or conditional word just before it. */
export function affirms(text: string, re: RegExp): boolean {
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - WINDOW), m.index ?? 0);
    // "not verified", "will be processed once you confirm" do not affirm the outcome.
    if (!NEGATION.test(before)) return true;
  }
  return false;
}

const numbersIn = (t: string): Set<number> => {
  const out = new Set<number>();
  for (const m of t.replace(/(?<=\d),(?=\d{3})/g, "").matchAll(/\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
  return out;
};

export function verifyGrounding(approved: string, spoken: string): GroundingVerdict {
  // Only complete words: a transcript delta can end mid-word ("approv").
  const complete = /\s$/.test(spoken) ? spoken : spoken.replace(/\S+$/, "");
  if (!complete.trim()) return { ok: true };

  const allowed = numbersIn(approved);
  for (const n of numbersIn(complete)) if (!allowed.has(n)) return { ok: false, reason: `number ${n} is not in the verified answer` };

  for (const c of CLAIMS) {
    if (affirms(complete, c.spoken) && !affirms(approved, c.supported)) return { ok: false, reason: `unsupported ${c.name} claim` };
  }
  return { ok: true };
}
