const STOPWORDS = new Set(
  `a an the and or but if then so of to in on at by for with about from into over under up down out off as is are was
were be been being am do does did done have has had having i me my mine we our you your he she it its they them their
this that these those can could would should will shall may might must not no yes please hi hello hey thanks thank what
whats which who whom whose when where why how also just very really any some all more most than too get got give gives
let want need like know tell help there here one`.split(/\s+/),
);

/** Multi-word phrases collapsed to one canonical token before tokenising. */
const PHRASES: Array<[RegExp, string]> = [
  [/\bmoney back\b/g, " refund "],
  [/\bget my money\b/g, " refund "],
  [/\blog ?in\b|\bsign ?in\b|\blog on\b/g, " login "],
  [/\bcharged twice\b|\bdouble charge[d]?\b|\bduplicate charge[s]?\b/g, " duplicate charge "],
  [/\bapi limit[s]?\b/g, " api rate limit "],
  [/\btoo many requests\b/g, " rate limit "],
  [/\bspeak to (a )?(human|person|agent)\b|\btalk to (a )?(human|person|agent)\b/g, " escalate human "],
];

/** Small domain synonym map so the offline embedder and verifier survive paraphrase. */
const SYNONYMS: Record<string, string> = {
  reimburse: "refund",
  reimbursement: "refund",
  refunded: "refund",
  refunds: "refund",
  reverse: "refund",
  reversed: "refund",
  cancellation: "cancel",
  cancelled: "cancel",
  canceled: "cancel",
  cancelling: "cancel",
  canceling: "cancel",
  terminate: "cancel",
  termination: "cancel",
  unsubscribe: "cancel",
  charged: "payment",
  charge: "payment",
  payments: "payment",
  invoice: "invoice",
  invoices: "invoice",
  receipt: "invoice",
  receipts: "invoice",
  password: "login",
  throttled: "rate",
  throttling: "rate",
  "429": "rate",
  upgrade: "upgrade",
  upgrades: "upgrade",
  downgrade: "downgrade",
  downgrades: "downgrade",
  annually: "annual",
  yearly: "annual",
  year: "annual",
  month: "monthly",
  human: "escalate",
};

function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/** Lowercased, phrase-normalised, stopword-free, lightly stemmed tokens. */
export function contentTokens(text: string): string[] {
  let t = text.toLowerCase().replace(/['’]/g, "");
  for (const [re, rep] of PHRASES) t = t.replace(re, rep);
  return t
    .split(/[^a-z0-9$]+/)
    .filter(Boolean)
    .map((w) => stem(SYNONYMS[w] ?? w))
    .map((w) => SYNONYMS[w] ?? w)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.33);
}
