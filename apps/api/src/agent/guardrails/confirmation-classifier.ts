export type ConfirmationReply = "confirm" | "decline" | "other";

const CONFIRM = /^(?:(?:yes|yep|yeah|yup|sure|ok|okay|confirm(?:ed)?|correct|proceed|go ahead|do it|please do|that'?s right|affirmative)(?:[\s,.!]+(?:please|thanks|thank you|go ahead|proceed|do it|confirm))*)[\s.!]*$/i;
const DECLINE = /^(?:no|nope|nah|cancel|stop|don'?t|do not|never ?mind|decline|negative|not now|abort)(?:[\s,.!]+(?:thanks|thank you|please|don'?t|cancel|stop|do it|that|it|go))*[\s.!]*$/i;

/**
 * Deterministic and deliberately strict: only a bare, unambiguous yes/no counts. Anything else (including
 * "yes, and also change my name") is "other", which cancels the pending action and is handled as a new request.
 * The customer's confirmation is a backend decision, never the model's interpretation.
 */
export function classifyConfirmationReply(text: string): ConfirmationReply {
  const t = text.trim();
  if (!t || t.length > 60) return "other";
  if (DECLINE.test(t)) return "decline";
  if (CONFIRM.test(t)) return "confirm";
  return "other";
}
