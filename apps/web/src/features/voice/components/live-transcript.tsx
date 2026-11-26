import type { TranscriptEntry } from "../types";

interface Props { entries: TranscriptEntry[]; partialUser: string; partialAssistant: string }

/** Completed turns plus the in-progress captions. Partial text is a caption only; the persisted message comes from the backend. */
export function LiveTranscript({ entries, partialUser, partialAssistant }: Props) {
  const recent = entries.slice(-4);
  if (!recent.length && !partialUser && !partialAssistant) return <p className="text-xs text-faint" data-testid="live-transcript-empty">Your conversation will appear here as you speak.</p>;
  return (
    <ul className="space-y-1.5" data-testid="live-transcript" aria-label="Live transcript">
      {recent.map((e) => <Line key={`${e.turnId}-${e.role}`} role={e.role} text={e.text} note={e.interrupted ? "interrupted" : undefined} />)}
      {partialUser && <Line role="user" text={partialUser} partial />}
      {partialAssistant && <Line role="assistant" text={partialAssistant} partial />}
    </ul>
  );
}

function Line({ role, text, partial, note }: { role: "user" | "assistant"; text: string; partial?: boolean; note?: string }) {
  return (
    <li data-testid="transcript-line" data-role={role} data-partial={partial ? "true" : "false"} className="text-sm leading-snug">
      <span className="mr-2 text-xs font-medium uppercase tracking-wide text-faint">{role === "user" ? "You" : "SupportAI"}</span>
      <span className={partial ? "text-faint" : "text-ink"}>{text}{partial ? "…" : ""}</span>
      {note && <span className="ml-2 text-xs text-faint">({note})</span>}
    </li>
  );
}
