"use client";

import { useQuery } from "@tanstack/react-query";
import type { SessionView } from "@support-ai/contracts";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { authed, useAuthStore } from "@/features/auth/auth.store";
import { useDebounced } from "@/lib/use-debounced";
import { ConversationItem } from "./conversation-item";
import { NewConversationButton } from "./new-conversation-button";

interface Item {
  id: string;
  view: SessionView | null;
  unavailable: boolean;
}

interface Props {
  conversations: Item[];
  activeId: string | null;
  creating: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onRemove: (id: string) => void;
}

export function ConversationSidebar({ conversations, activeId, creating, onNew, onSelect, onRename, onRemove }: Props) {
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim());
  const signedIn = useAuthStore((s) => s.status === "authed");
  // Signed-in: the server searches titles and message text. Anonymous demo visitors have no account list, so titles only.
  const matches = useQuery({
    queryKey: ["me/sessions", term],
    queryFn: () => authed<Array<{ id: string }>>(`/me/sessions?${new URLSearchParams({ q: term })}`),
    enabled: signedIn && term !== "",
    placeholderData: (prev) => prev, // keep the last results while the next term loads, no flash of the full list
  });
  const ids = matches.data && new Set(matches.data.map((s) => s.id));
  const shown = !term ? conversations
    : signedIn ? (ids ? conversations.filter((c) => ids.has(c.id)) : conversations)
    : conversations.filter((c) => (c.view?.title ?? "").toLowerCase().includes(term.toLowerCase()));

  return (
    <nav aria-label="Conversations" className="flex h-full min-h-0 flex-col gap-3 p-3">
      <NewConversationButton onClick={onNew} loading={creating} />
      <Input type="search" aria-label="Search conversations" placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="-mx-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto" data-testid="conversation-list">
        {conversations.length === 0 && <li className="px-3 py-2 text-sm text-faint">No conversations yet.</li>}
        {conversations.length > 0 && term && matches.isError && <li className="px-3 py-2 text-sm text-faint">Search is unavailable right now.</li>}
        {conversations.length > 0 && term && !matches.isError && shown.length === 0 && <li className="px-3 py-2 text-sm text-faint">No conversations match “{term}”.</li>}
        {shown.map((c) => (
          <ConversationItem key={c.id} title={c.view?.title ?? "Conversation"} updatedAt={c.view?.updatedAt} unavailable={c.unavailable} active={c.id === activeId} onSelect={() => onSelect(c.id)} onRename={(t) => onRename(c.id, t)} onRemove={() => onRemove(c.id)} />
        ))}
      </ul>
    </nav>
  );
}
