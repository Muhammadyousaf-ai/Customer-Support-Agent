"use client";

import type { Role } from "@support-ai/contracts";
import { BookOpen, ClipboardList, LayoutDashboard, LogOut, MessageSquare, Moon, ScrollText, Settings, Sun, Ticket, UserCog, Users, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { homeFor, useAuthStore } from "@/features/auth/auth.store";
import { useTheme } from "@/features/workspace/hooks/use-theme";
import { NotificationBell } from "./notification-bell";

const NAV: Record<Role, Array<{ href: string; label: string; icon: LucideIcon }>> = {
  admin: [
    { href: "/admin", label: "Overview", icon: LayoutDashboard }, { href: "/admin/tickets", label: "Tickets", icon: Ticket }, { href: "/admin/kb", label: "Knowledge base", icon: BookOpen },
    { href: "/admin/staff", label: "Staff", icon: UserCog }, { href: "/admin/customers", label: "Customers", icon: Users }, { href: "/admin/audit", label: "Audit log", icon: ScrollText }, { href: "/admin/settings", label: "Settings", icon: Settings },
  ],
  staff: [{ href: "/staff", label: "Dashboard", icon: LayoutDashboard }, { href: "/staff/tickets", label: "Tickets", icon: ClipboardList }],
  customer: [{ href: "/customer/tickets", label: "My tickets", icon: Ticket }, { href: "/support", label: "AI assistant", icon: MessageSquare }],
};
const requiredRole = (path: string): Role | null => (path.startsWith("/admin") ? "admin" : path.startsWith("/staff") ? "staff" : path.startsWith("/customer") ? "customer" : null);
export const ticketBaseFor = (role: Role) => (role === "admin" ? "/admin/tickets" : role === "staff" ? "/staff/tickets" : "/customer/tickets");

/** Role-aware chrome. The route guard here is a convenience (no flash of a forbidden page); the API enforces every permission itself. */
export function PortalShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const { status, user, bootstrap, logout } = useAuthStore();
  const [, , dark, toggleTheme] = useTheme();
  useEffect(() => { void bootstrap(); }, [bootstrap]);
  const need = requiredRole(path);
  const allowed = status === "authed" && user && (!need || user.role === need);
  useEffect(() => {
    if (status === "anon") router.replace(`/login?next=${encodeURIComponent(path)}`);
    else if (status === "authed" && user && need && user.role !== need) router.replace(homeFor(user.role));
  }, [status, user, need, path, router]);

  if (!allowed || !user) return <div className="app-content flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground" role="status">Loading…</div>;
  const isActive = (href: string) => (href.split("/").length > 2 ? path === href || path.startsWith(`${href}/`) : path === href);
  const links = NAV[user.role];
  return (
    <div className="app-content flex h-dvh flex-col bg-background">
      <header className="flex h-topbar shrink-0 items-center justify-between border-b border-rule px-6">
        <Link href={homeFor(user.role)} className="text-base font-semibold text-ink">Support AI</Link>
        <div className="flex items-center gap-1">
          <NotificationBell ticketBase={ticketBaseFor(user.role)} />
          <Button variant="ghost" size="icon" aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={toggleTheme}>{dark ? <Sun /> : <Moon />}</Button>
          <span className="hidden px-2 text-sm text-body sm:inline" data-testid="current-user">{user.displayName} · {user.role}</span>
          <Button variant="outline" size="sm" onClick={async () => { await logout(); router.replace("/login"); }}><LogOut /> Sign out</Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="shrink-0 border-b border-rule bg-sidebar md:w-sidebar md:border-b-0 md:border-r">
          <nav aria-label="Main" className="flex gap-1 overflow-x-auto p-3 md:flex-col md:overflow-visible">
            {links.map((n) => {
              const active = isActive(n.href);
              return (
                <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm whitespace-nowrap transition-colors duration-100 active:scale-[0.98] ${active ? "bg-sidebar-accent font-medium text-ink" : "text-body hover:bg-sidebar-accent/60 hover:text-ink"}`}>
                  <n.icon className="size-4 shrink-0" aria-hidden /> {n.label}
                </Link>
              );
            })}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-6 py-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
