import { Markdown } from "./message-bubble";

/** The assistant's answer as it is released. Verified text arrives in chunks (buffered streaming, not raw tokens). */
export function StreamingMessage({ text }: { text: string }) {
  return (
    <div data-testid="streaming-message" className="flex w-full justify-start" aria-live="polite">
      <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-muted px-4 py-2.5 sm:max-w-[75%]">
        <Markdown>{text}</Markdown>
        <span aria-hidden className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-ink/60 align-middle" />
      </div>
    </div>
  );
}
