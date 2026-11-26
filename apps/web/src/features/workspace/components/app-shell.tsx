"use client";

import { useState, type ReactNode } from "react";
import { homeFor, useAuthStore } from "@/features/auth/auth.store";
import { Activity, LogOut, Moon, Sun } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ObservabilityDrawer } from "@/features/observability/components/observability-drawer";
import { useTheme } from "../hooks/use-theme";

/** Top bar + main column + collapsible observability drawer. `app-content` scopes the dark token remap. */
export function AppShell({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [, , dark, toggleTheme] = useTheme();
  const router = useRouter();
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user); // the (workspace) layout guard guarantees a signed-in user
  return (
    <div className="app-content flex h-dvh flex-col bg-background">
      <header className="flex h-topbar shrink-0 items-center justify-between border-b border-rule px-6">
        <h1 className="text-base font-semibold text-ink">Support AI</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
            onClick={toggleTheme}
          >
            {dark ? <Sun /> : <Moon />}
          </Button>
          {user && <Button asChild variant="outline" size="sm"><Link href={homeFor(user.role)} data-testid="account-link">{user.role === "customer" ? "My tickets" : "Dashboard"}</Link></Button>}
          <Button
            variant="outline"
            size="sm"
            className="app-toggle"
            aria-pressed={drawerOpen}
            data-testid="observability-toggle"
            onClick={() => setDrawerOpen((o) => !o)}
          >
            <Activity /> Observability
          </Button>
          <Button variant="outline" size="sm" onClick={async () => { await logout(); router.replace("/login"); }}><LogOut /> Sign out</Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
        {drawerOpen && <ObservabilityDrawer onClose={() => setDrawerOpen(false)} />}
      </div>
    </div>
  );
}
