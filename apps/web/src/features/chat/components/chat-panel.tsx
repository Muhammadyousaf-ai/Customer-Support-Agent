import { Input } from "@/components/ui/input";

export function ChatPanel() {
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto p-6">
        <p className="text-sm text-faint">Start a conversation with the support agent.</p>
      </div>
      <div className="h-composer shrink-0 border-t border-rule px-6 py-3">
        <Input aria-label="Message" placeholder="Ask about your subscription, refunds or technical issues" disabled />
      </div>
    </section>
  );
}
