import { formatMoney } from "@/features/chat/format";
import type { RefundResult } from "@/features/chat/types";

/** Shown only from the backend's committed-refund result, never from model text. */
export function RefundResultCard({ refund }: { refund: RefundResult }) {
  return (
    <section aria-label="Refund completed" data-testid="refund-result" className="my-3 rounded-2xl border border-divider bg-card p-5 shadow-card">
      <h3 className="text-sm font-semibold text-ink">Refund completed</h3>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-ink">{formatMoney(refund.amountCents, refund.currency)}</p>
      <p className="mt-3 text-xs uppercase tracking-wide text-faint">Reference number</p>
      <p data-testid="refund-reference" className="font-mono text-base text-ink">{refund.refundId}</p>
      <p className="mt-3 text-xs text-muted-foreground">Payment {refund.paymentId}{refund.simulated ? " · Simulated transaction" : ""}</p>
    </section>
  );
}
