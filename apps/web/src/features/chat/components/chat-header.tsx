import { Menu } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function ChatHeader({ title, onOpenSidebar, actions }: { title: string; onOpenSidebar: () => void; actions?: ReactNode }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-rule px-4 sm:px-6">
      <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open conversations" onClick={onOpenSidebar}>
        <Menu />
      </Button>
      <h2 className="truncate text-sm font-medium text-ink" data-testid="chat-title">{title}</h2>
      {actions}
    </div>
  );
}
