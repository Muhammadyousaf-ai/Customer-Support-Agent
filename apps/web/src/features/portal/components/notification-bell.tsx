"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { authed } from "@/features/auth/auth.store";
import { useNotifications } from "./use-notifications";

export function NotificationBell({ ticketBase }: { ticketBase: string }) {
  const { data } = useNotifications();
  const qc = useQueryClient();
  const unread = data?.unread ?? 0;
  const markAll = async () => {
    await authed("/me/notifications/read", { method: "POST" });
    await qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} className="relative" data-testid="notification-bell">
          <Bell />
          {unread > 0 && <span className="absolute right-1 top-1 text-[10px] font-semibold leading-none text-ink" data-testid="notification-count">{unread}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-rule px-3 py-2">
          <span className="text-sm font-medium text-ink">Notifications</span>
          {unread > 0 && <Button variant="link" size="sm" onClick={markAll}>Mark all read</Button>}
        </div>
        <ul className="max-h-80 overflow-y-auto">
          {(data?.items ?? []).length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing new.</li>}
          {(data?.items ?? []).map((n) => {
            const body = (
              <>
                <p className={`text-sm text-ink ${n.read ? "" : "font-semibold"}`}>{n.title}</p>
                {n.body && <p className="line-clamp-2 text-xs text-muted-foreground">{n.body}</p>}
                <p className="mt-0.5 text-[11px] text-muted-foreground">{new Date(n.createdAt).toLocaleString()}</p>
              </>
            );
            return <li key={n.id} className="border-b border-rule last:border-0">{n.ticketId ? <Link className="block px-3 py-2 hover:bg-accent" href={`${ticketBase}/${n.ticketId}`}>{body}</Link> : <div className="px-3 py-2">{body}</div>}</li>;
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
