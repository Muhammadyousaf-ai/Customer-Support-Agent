import { Button } from "@/components/ui/button";

const SUGGESTIONS = [
  "What is your refund policy for monthly plans?",
  "I was charged yesterday but barely use the app. Can I get my money back?",
  "What plan am I on?",
  "Can you predict cryptocurrency prices?",
];

export function EmptyChat({ onPick, disabled }: { onPick: (text: string) => void; disabled?: boolean }) {
  return (
    <div data-testid="empty-chat" className="mx-auto flex max-w-xl flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <div>
        <h2 className="text-xl font-semibold text-ink">How can we help?</h2>
        <p className="mt-2 text-sm text-muted-foreground">Ask about plans, billing and refunds. The agent shows each step it takes as it works.</p>
      </div>
      <div className="flex w-full flex-col gap-2">
        {SUGGESTIONS.map((s) => (
          <Button key={s} variant="outline" className="h-auto justify-start whitespace-normal py-2.5 text-left font-normal" disabled={disabled} onClick={() => onPick(s)}>
            {s}
          </Button>
        ))}
      </div>
      <p className="text-xs text-faint">
        Demo account for account questions: <span className="font-mono">sarah@example.com</span>, code <span className="font-mono">482910</span> (fictional).
      </p>
    </div>
  );
}
