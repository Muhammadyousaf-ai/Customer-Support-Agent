import type { GuardrailName } from "@support-ai/contracts";
import type { AgentStateType } from "../state/agent-state.js";

export interface GuardrailFailure {
  guardrail: GuardrailName;
  reason: string;
}

export interface VerificationInput {
  response: string;
  sourceIds: string[];
  state: Pick<AgentStateType, "retrievedDocuments" | "toolResults" | "completedActions" | "identityVerified" | "retrievalInsufficient" | "messages">;
}

export interface VerificationOutcome {
  ok: boolean;
  failures: GuardrailFailure[];
  /** Guardrails that ran and passed, for the event stream. */
  passed: GuardrailName[];
}

// --- what the response claims happened -------------------------------------------------------------------------
const CLAIMS: Array<{ name: string; re: RegExp; satisfiedBy: (s: VerificationInput["state"]) => boolean }> = [
  {
    name: "a refund was issued",
    re: /\b(?:i(?:'ve| have)?\s+(?:processed|issued|completed|submitted|initiated|refunded)|(?:has|have|had) been\s+(?:processed|issued|refunded|completed)|was\s+(?:processed|issued|refunded)|your refund (?:has|was|is now)\b|(?:i(?:'ve| have)?|we(?:'ve| have)?)\s+refunded)/i,
    satisfiedBy: (s) => s.completedActions.some((a) => a.type === "refund"),
  },
  {
    name: "a support ticket was created",
    re: /\b(?:i(?:'ve| have)?\s+(?:created|opened|submitted|raised|filed|logged)|ticket\s+(?:has been|was)\s+(?:created|opened|raised)|(?:created|opened)\s+(?:a|an|your)\s+(?:support\s+)?ticket)/i,
    satisfiedBy: (s) => s.completedActions.some((a) => a.type === "escalation"),
  },
  {
    name: "an account detail was changed",
    re: /\b(?:i(?:'ve| have)?\s+(?:updated|changed)|has been\s+(?:updated|changed)|successfully\s+(?:updated|changed)|your (?:display name|timezone|language|notification preferences?) (?:is now|has been|was))/i,
    satisfiedBy: (s) => s.completedActions.some((a) => a.type === "account_update"),
  },
  {
    name: "the customer's identity was verified",
    re: /\b(?:you(?:'re| are)\s+(?:now\s+)?verified|i(?:'ve| have)\s+verified you|identity\s+(?:has been\s+|is\s+)?(?:successfully\s+)?verified|verification (?:was )?successful)/i,
    satisfiedBy: (s) => s.identityVerified,
  },
];

// --- identifiers and numbers must exist in real evidence --------------------------------------------------------
const ID_RE = /\b(?:REF-\d+|TKT-\d+|PAY-[A-Z0-9-]+|CUST-\d+|ACT-[a-f0-9]{10})\b/g;
const MONEY_RE = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g;
const UNIT_RE = /\b(\d[\d,.]*)\s*(%|percent|days?|business days?|hours?|weeks?|months?|years?|requests?(?:\s+per\s+\w+)?)/gi;

/** Words that signal a statement about company policy or terms (as opposed to chit-chat or a question). */
const POLICY_RE = /\b(?:policy|policies|refund window|within \d+ (?:days?|hours?)|eligib\w+|allowed|not allowed|permitted|limits?|requires? (?:human )?approval|terms and conditions)\b/i;

const evidenceCorpus = (s: VerificationInput["state"]): string =>
  [
    ...s.retrievedDocuments.map((d) => `${d.heading} ${d.content}`),
    ...s.toolResults.map((r) => r.summary),
    ...s.messages.filter((m) => m.role === "user" || m.role === "tool").map((m) => m.content),
  ].join("\n");

const numbersIn = (text: string): Set<number> => {
  const out = new Set<number>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
};

/**
 * Deterministic response verification (no model involved):
 *  - result verification: no claiming an action succeeded unless a tool confirmed it
 *  - no fabricated ids, dollar amounts or policy numbers (every one must appear in tool results, retrieved policy
 *    text or the customer's own words)
 *  - scope / retrieval / evidence: policy statements must be backed by retrieval and cite valid sources
 */
export function verifyResponse(input: VerificationInput): VerificationOutcome {
  const { response, sourceIds, state } = input;
  const failures: GuardrailFailure[] = [];
  const ran = new Set<GuardrailName>();
  const fail = (guardrail: GuardrailName, reason: string) => failures.push({ guardrail, reason });

  // 1. result verification
  ran.add("result_verification");
  for (const c of CLAIMS) {
    if (c.re.test(response) && !c.satisfiedBy(state)) fail("result_verification", `You claimed ${c.name}, but no tool result confirms that. Only report what a tool actually confirmed.`);
  }
  const corpus = evidenceCorpus(state);
  const corpusLower = corpus.toLowerCase();
  const corpusNumbers = numbersIn(corpus);
  for (const id of new Set(response.match(ID_RE) ?? [])) {
    if (!corpusLower.includes(id.toLowerCase())) fail("result_verification", `The reference ${id} does not appear in any tool result or in what the customer said. Do not invent references.`);
  }
  for (const m of response.matchAll(MONEY_RE)) {
    const dollars = Number(m[1]!.replace(/,/g, ""));
    const supported = corpusNumbers.has(dollars) || corpusNumbers.has(Math.round(dollars * 100));
    if (!supported) fail("result_verification", `The amount $${m[1]} is not supported by any tool result, policy passage or customer statement.`);
  }

  // 2. evidence verification of policy numbers (windows, limits, percentages)
  ran.add("evidence_verification");
  for (const m of response.matchAll(UNIT_RE)) {
    const n = Number(m[1]!.replace(/,/g, ""));
    if (Number.isFinite(n) && !corpusNumbers.has(n)) fail("evidence_verification", `"${m[0]}" is not stated in the retrieved policy text or tool results.`);
  }

  // 3. scope / retrieval confidence / citations for policy claims
  const retrieved = new Map(state.retrievedDocuments.map((d) => [d.id, d]));
  const invalid = sourceIds.filter((id) => !retrieved.has(id));
  if (invalid.length) fail("evidence_verification", `You cited sources that were never retrieved: ${invalid.join(", ")}.`);
  const makesPolicyClaims = POLICY_RE.test(response) && !/\?\s*$/.test(response.trim());
  const searched = state.toolResults.some((r) => r.tool === "search_knowledge_base" && r.success);
  const decidedByBackend = state.toolResults.some((r) => r.tool === "check_refund_eligibility" && r.success);
  if (makesPolicyClaims && sourceIds.length === 0 && !decidedByBackend) {
    if (!searched) fail("scope", "Your answer states company policy but you have not retrieved any policy. Call search_knowledge_base first, or escalate if this is out of scope.");
    else if (state.retrievalInsufficient) fail("retrieval_confidence", "Policy retrieval found no sufficiently supported evidence, so you must not answer this from your own knowledge. Ask a clarifying question or escalate.");
    else fail("evidence_verification", "Your answer states company policy without citing the sourceIds that support it.");
  }
  ran.add("scope");
  ran.add("retrieval_confidence");

  const failed = new Set(failures.map((f) => f.guardrail));
  return { ok: failures.length === 0, failures, passed: [...ran].filter((g) => !failed.has(g)) };
}

/** Evidence text handed to the optional LLM evidence check. */
export function evidenceForLlm(state: VerificationInput["state"], sourceIds: string[]): string {
  const cited = state.retrievedDocuments.filter((d) => sourceIds.includes(d.id)).map((d) => `[policy ${d.id}] ${d.heading}: ${d.content}`);
  const tools = state.toolResults.filter((r) => r.success).map((r) => `[tool ${r.tool}] ${r.summary}`);
  return [...cited, ...tools].join("\n").slice(0, 12_000);
}
