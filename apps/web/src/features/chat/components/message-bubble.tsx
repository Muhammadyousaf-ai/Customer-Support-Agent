import { AlertCircle, AudioLines } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { cn } from "@/lib/utils";
import { RetryButton } from "@/features/feedback/components/retry-button";

/** http(s) and mailto only: no javascript: or data: URLs from model output. */
const safeUrl = (url: string) => (/^(https?:|mailto:)/i.test(url) ? url : "");

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-chat text-[15px] leading-relaxed text-ink [&_ol]:ml-5 [&_ol]:list-decimal [&_p+p]:mt-2 [&_ul]:ml-5 [&_ul]:list-disc [&_code]:rounded [&_code]:bg-wash [&_code]:px-1 [&_code]:font-mono [&_code]:text-[13px] [&_strong]:font-semibold">
      {/* skipHtml: raw HTML in a message is dropped, never rendered. Images are not allowed at all. */}
      <ReactMarkdown skipHtml urlTransform={safeUrl} components={{ img: () => null, a: ({ href, children: c }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2">{c}</a> }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

interface Props {
  role: "user" | "assistant";
  content: string;
  state?: "sending" | "failed";
  onRetry?: () => void;
  errorText?: string;
  /** Spoken in voice mode: shown with a small marker so a mixed conversation reads naturally. */
  voice?: boolean;
  /** Set for a human support agent's reply so it is never mistaken for the AI. */
  byline?: string;
}

export function MessageBubble({ role, content, state, onRetry, errorText, voice, byline }: Props) {
  const user = role === "user";
  return (
    <div data-testid="message" data-role={role} data-state={state ?? "sent"} data-mode={voice ? "voice" : "chat"} className={cn("flex w-full", user ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[85%] sm:max-w-[75%]", user ? "rounded-2xl rounded-br-md bg-primary text-primary-foreground px-4 py-2.5" : "rounded-2xl rounded-bl-md bg-muted px-4 py-2.5")}>
        {byline && <p className="mb-0.5 text-xs font-medium text-muted-foreground">{byline}</p>}
        {user ? <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-primary-foreground">{content}</p> : <Markdown>{content}</Markdown>}
        {voice && <p className={cn("mt-1 flex items-center gap-1 text-xs", user ? "text-primary-foreground/80" : "text-faint")}><AudioLines aria-hidden className="size-3" /> Voice</p>}
        {state === "sending" && <p className="mt-1 text-xs text-primary-foreground/80">Sending&hellip;</p>}
        {state === "failed" && (
          <div className={cn("mt-2 flex items-center gap-2 text-xs", user ? "text-primary-foreground/90" : "text-muted-foreground")}>
            <AlertCircle aria-hidden className="size-3.5" /> {errorText ?? "Not sent."}
            {onRetry && <RetryButton onRetry={onRetry} label="Retry" />}
          </div>
        )}
      </div>
    </div>
  );
}
