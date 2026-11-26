"use client";

import type { Role } from "@support-ai/contracts";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { homeFor, useAuthStore } from "../auth.store";

/** Keeps signed-out visitors (and roles that may not use a page) out of it. The API enforces the same rules; this avoids a flash of the page. */
export function RequireAuth({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const { status, user, bootstrap } = useAuthStore();
  useEffect(() => { void bootstrap(); }, [bootstrap]);
  const allowed = status === "authed" && user !== null && roles.includes(user.role);
  useEffect(() => {
    if (status === "anon") router.replace(`/login?next=${encodeURIComponent(path)}`);
    else if (status === "authed" && user && !roles.includes(user.role)) router.replace(homeFor(user.role));
  }, [status, user, roles, path, router]);
  if (!allowed) return <div className="app-content flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground" role="status">Loading…</div>;
  return <>{children}</>;
}
