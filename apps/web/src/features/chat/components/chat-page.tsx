"use client";

import { useCallback, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ConversationSidebar } from "@/features/conversations/components/conversation-sidebar";
import { useConversations } from "../hooks/use-conversations";
import { ChatWorkspace } from "./chat-workspace";
import { EmptyChat } from "./empty-chat";
import { sendMessage } from "../services/chat.service";
import { createSession } from "../services/session.service";
import { useConversationsStore } from "../store/conversations.store";

/** Sidebar + workspace. On small screens the sidebar becomes a slide-over panel. */
export function ChatPage() {
  const { ready, conversations, active, activeId, create, rename, select, remove, recover } = useConversations();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  // A conversation with no messages and no running turn is already "new": another click must not stack empty ones.
  const onNewConversation = () => {
    const blank = active && !active.unavailable && !active.view?.lastMessage && !active.view?.activeRun;
    if (blank) return setSidebarOpen(false);
    create.mutate(undefined, { onSuccess: () => setSidebarOpen(false) });
  };
  const onUnavailable = useCallback(() => activeId && recover(activeId), [activeId, recover]);

  const sidebar = (
    <ConversationSidebar
      conversations={conversations}
      activeId={activeId}
      creating={create.isPending}
      onNew={onNewConversation}
      onSelect={(id) => { select(id); setSidebarOpen(false); }}
      onRename={(id, title) => rename.mutate({ id, title })}
      onRemove={remove}
    />
  );

  /** First message from the empty state: create the conversation, then send into it. */
  const startWith = async (text: string) => {
    setStarting(true);
    try {
      const s = await createSession();
      useConversationsStore.getState().add({ id: s.sessionId, token: s.sessionToken, createdAt: new Date().toISOString() });
      await sendMessage(s.sessionId, s.sessionToken, text, crypto.randomUUID());
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-sidebar shrink-0 border-r border-rule bg-sidebar md:block">{sidebar}</aside>
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-[85%] max-w-xs p-0">
          <SheetHeader className="sr-only"><SheetTitle>Conversations</SheetTitle></SheetHeader>
          {sidebar}
        </SheetContent>
      </Sheet>
      <main className="flex min-w-0 flex-1 flex-col">
        {!ready ? null : active ? (
          <ChatWorkspace key={active.id} conversation={{ id: active.id, token: active.token }} title={active.view?.title ?? "Conversation"} onOpenSidebar={() => setSidebarOpen(true)} onUnavailable={onUnavailable} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto"><EmptyChat onPick={(t) => void startWith(t)} disabled={starting} /></div>
        )}
      </main>
    </div>
  );
}
