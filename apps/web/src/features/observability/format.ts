export const ms = (n: number | null | undefined): string => (n === null || n === undefined ? "n/a" : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);
export const tokens = (n: number): string => n.toLocaleString("en-US");
/** Costs are fixed-precision strings from the API. null is "unavailable": it must never render as $0. */
export const usd = (c: string | null | undefined): string => (c === null || c === undefined ? "Unavailable" : `$${c}`);
export const json = (v: unknown): string => { try { return JSON.stringify(v, null, 2) ?? ""; } catch { return String(v); } };
export const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour12: false });
