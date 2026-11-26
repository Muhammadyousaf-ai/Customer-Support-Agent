export const SUMMARY_SYSTEM = `You compress a customer support conversation into a short factual summary for the agent's memory.
Keep: what the customer wants, identity status, actions already completed (with ids), decisions still pending, and any facts the customer stated.
Drop: greetings and filler. Never include verification codes. Do not invent anything. Maximum 120 words.`;

export const summaryPrompt = (existing: string | null, transcript: string) =>
  `${existing ? `Existing summary:\n${existing}\n\n` : ""}Conversation to fold in:\n${transcript}`;
