"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { PendingActionView } from "@support-ai/contracts";
import { formatMoney } from "@/features/chat/format";

/** Remaining milliseconds, derived on every render so a changed expiry is reflected immediately (the tick only re-renders). */
function useCountdown(expiresAt: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  return new Date(expiresAt).getTime() - now;
}

/**
 * Renders a pending action from trusted backend data. Confirm/decline send the action id to the backend, which
 * re-validates identity, ownership, expiry and arguments. Nothing here claims success; that arrives as a result card.
 */
export function ConfirmationCard({ action, busy, onConfirm, onDecline }: { action: PendingActionView; busy: boolean; onConfirm: () => void; onDecline: () => void }) {
  const left = useCountdown(action.expiresAt);
  const expired = left <= 0;
  const isRefund = action.type === "refund";
  return (
    <section aria-label="Action confirmation" data-testid="confirmation-card" className="my-3 rounded-2xl border border-divider bg-card p-5 shadow-card">
      <h3 className="text-sm font-semibold text-ink">{isRefund ? "Refund confirmation" : "Account change confirmation"}</h3>
      <p className="mt-1 text-sm text-muted-foreground">Please review the proposed action before continuing.</p>
      {isRefund && action.amountCents !== undefined && (
        <>
          <p className="mt-4 text-xs uppercase tracking-wide text-faint">Refund amount</p>
          <p data-testid="confirmation-amount" className="text-3xl font-semibold tracking-tight text-ink">{formatMoney(action.amountCents, action.currency)}</p>
        </>
      )}
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        {Object.entries(action.display).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-xs text-faint">{expired ? "This confirmation has expired. Ask the agent to start again." : `Expires in ${Math.max(1, Math.ceil(left / 60_000))} min`}</p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onDecline} disabled={busy}>Cancel</Button>
        <Button onClick={onConfirm} disabled={busy || expired} loading={busy}>{isRefund ? "Confirm refund" : "Confirm change"}</Button>
      </div>
    </section>
  );
}
