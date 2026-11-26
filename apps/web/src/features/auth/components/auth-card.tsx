import Link from "next/link";
import type { ReactNode } from "react";

export function AuthCard({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="app-content flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm rounded-xl border border-rule bg-card p-6 shadow-card">
        <Link href="/support" className="text-sm font-semibold text-ink">Support AI</Link>
        <h1 className="mt-4 text-xl font-semibold text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
        <div className="mt-5">{children}</div>
        {footer && <div className="mt-5 border-t border-rule pt-4 text-sm text-muted-foreground">{footer}</div>}
      </div>
    </div>
  );
}
