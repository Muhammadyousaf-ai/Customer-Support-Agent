"use client";

import { Check, Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { timeAgo } from "@/features/chat/format";
import { cn } from "@/lib/utils";

interface Props {
  title: string;
  updatedAt?: string;
  active: boolean;
  unavailable?: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onRemove: () => void;
}

export function ConversationItem({ title, updatedAt, active, unavailable, onSelect, onRename, onRemove }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = () => {
    const t = draft.trim();
    if (t && t !== title) onRename(t);
    setEditing(false);
  };

  if (editing) {
    return (
      <li className="flex items-center gap-1 px-1">
        <Input aria-label="Conversation name" value={draft} maxLength={80} autoFocus onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} className="h-8" />
        <Button variant="ghost" size="icon-xs" aria-label="Save name" onClick={save}><Check /></Button>
        <Button variant="ghost" size="icon-xs" aria-label="Cancel rename" onMouseDown={(e) => e.preventDefault()} onClick={() => setEditing(false)}><X /></Button>
      </li>
    );
  }
  return (
    <li className={cn("group flex items-center rounded-lg", active && "bg-sidebar-accent")}>
      <Button variant="ghost" className="h-auto min-w-0 flex-1 justify-start px-3 py-2 text-left font-normal hover:bg-transparent" aria-current={active ? "true" : undefined} onClick={onSelect} data-testid="conversation-item">
        <span className="min-w-0">
          <span className="block truncate text-sm text-ink">{title}</span>
          <span className="block text-xs text-faint">{unavailable ? "Unavailable on this device" : updatedAt ? timeAgo(updatedAt) : "…"}</span>
        </span>
      </Button>
      <div className="flex pr-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <Button variant="ghost" size="icon-xs" aria-label={`Rename ${title}`} onClick={() => { setDraft(title); setEditing(true); }}><Pencil /></Button>
        <Button variant="ghost" size="icon-xs" aria-label={`Delete ${title}`} onClick={() => setConfirmDelete(true)}><Trash2 /></Button>
      </div>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>&ldquo;{title}&rdquo; will be removed from all your devices. Any support ticket opened from it stays open.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onRemove}>Delete conversation</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
