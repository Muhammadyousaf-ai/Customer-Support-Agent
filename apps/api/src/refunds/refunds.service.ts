import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
import { AuditService } from "../audit/audit.service.js";
import { ContractsService, type ContractRecord } from "../contracts/contracts.service.js";
import { CustomersService, type CustomerRecord } from "../customers/customers.service.js";
import { PG_POOL } from "../database/tokens.js";
import { PaymentsService, type PaymentRecord } from "../payments/payments.service.js";
import { SubscriptionsService, type SubscriptionRecord } from "../subscriptions/subscriptions.service.js";
import { ToolError } from "../tools/errors/tool-error.js";
import type { ToolExecutionContext } from "../tools/registry/tool-definition.interface.js";
import { RefundPolicyService, type RefundPolicyLookup } from "./refund-policy.service.js";
import { evaluateRefund, REFUND_WINDOW_DAYS, type RefundEvaluation, type RefundFacts } from "./refund-rules.js";
import { ENV } from "../config/tokens.js";
import type { Env } from "../config/env.js";

interface AccountFacts {
  customer: CustomerRecord | null;
  subscription: SubscriptionRecord | null;
  contract: ContractRecord | null;
}

export interface RefundRecord {
  refundId: string;
  paymentId: string;
  customerId: string;
  amountCents: number;
  amount: number;
  currency: string;
  status: string;
  simulated: boolean;
  /** True when this call returned an already-committed refund instead of creating a new one. */
  replayed: boolean;
}

interface RefundRow {
  id: string; payment_id: string; customer_id: string; amount_cents: number; currency: string; status: string; simulated: boolean;
}
const toRecord = (r: RefundRow, replayed: boolean): RefundRecord => ({
  refundId: r.id, paymentId: r.payment_id, customerId: r.customer_id, amountCents: r.amount_cents, amount: r.amount_cents / 100,
  currency: r.currency, status: r.status, simulated: r.simulated, replayed,
});

/** Maps a non-eligible evaluation to the structured error the agent sees. */
export function evaluationToError(e: RefundEvaluation): ToolError {
  const details = { reasonCode: e.reasonCode, decision: e.decision };
  switch (e.decision) {
    case "manual_approval_required":
      return new ToolError("MANUAL_APPROVAL_REQUIRED", e.explanation, false, details);
    case "escalate":
      return new ToolError("POLICY_NOT_FOUND", e.explanation, false, details);
    default:
      if (e.reasonCode === "IDENTITY_REQUIRED") return new ToolError("IDENTITY_REQUIRED", e.explanation, false, details);
      if (e.reasonCode === "PAYMENT_NOT_OWNED") return new ToolError("ACCESS_DENIED", "You can only refund your own payments.", false, details);
      return new ToolError("REFUND_NOT_ELIGIBLE", e.explanation, false, details);
  }
}

@Injectable()
export class RefundsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(ENV) private readonly env: Env,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
    @Inject(CustomersService) private readonly customers: CustomersService,
    @Inject(SubscriptionsService) private readonly subscriptions: SubscriptionsService,
    @Inject(ContractsService) private readonly contracts: ContractsService,
    @Inject(RefundPolicyService) private readonly policy: RefundPolicyService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Read-only evaluation (check_refund_eligibility). */
  async check(ctx: ToolExecutionContext, paymentId: string, requestedAmountCents?: number) {
    const payment = await this.payments.getById(paymentId);
    // Same answer for "missing" and "someone else's" so payment ids cannot be probed.
    if (!payment || payment.customerId !== ctx.customerId) {
      throw new ToolError("ACCESS_DENIED", "That payment was not found on your account.");
    }
    const account = await this.loadAccount(payment.customerId);
    const policy = await this.lookupPolicy(account);
    const facts = this.buildFacts(ctx, payment, account, policy, requestedAmountCents);
    return { evaluation: evaluateRefund(facts), payment, policy, limits: { windowDays: REFUND_WINDOW_DAYS, maxAutoRefundCents: facts.maxAutoRefundCents } };
  }

  /**
   * Transactional, idempotent refund (issue_refund).
   *  1. A retry with a known idempotency key returns the original refund, so a lost response never double-refunds.
   *  2. The payment row is locked and eligibility is re-checked inside the transaction.
   *  3. UNIQUE(payment_id) and CHECK(refunded_cents <= amount_cents) make a duplicate impossible even under races.
   *
   * Pool rule: while a transaction client is held, only that client is used. Querying the shared pool from
   * inside the transaction can starve the pool (every connection blocked on the row lock, the lock holder
   * waiting for a free one), so all pool-based reads happen before the transaction starts.
   */
  async issue(ctx: ToolExecutionContext, paymentId: string, requestedAmountCents?: number): Promise<RefundRecord> {
    const key = ctx.idempotencyKey;
    if (!key || !ctx.customerId) throw new ToolError("INTERNAL_ERROR", "Missing idempotency key or verified customer.");

    const replay = await this.findByKey(key, paymentId, ctx.customerId, requestedAmountCents);
    if (replay) return replay;

    const preview = await this.payments.getById(paymentId);
    if (!preview || preview.customerId !== ctx.customerId) throw new ToolError("ACCESS_DENIED", "That payment was not found on your account.");
    const account = await this.loadAccount(ctx.customerId);
    const policy = await this.lookupPolicy(account);

    try {
      return await this.issueInTransaction(ctx, key, paymentId, requestedAmountCents, account, policy);
    } catch (err) {
      // Lost a race on a unique constraint: someone else committed first. The client is already released here,
      // so resolving to the committed state through the pool is safe.
      if ((err as { code?: string }).code === "23505") {
        const existing = await this.findByKey(key, paymentId, ctx.customerId, requestedAmountCents);
        if (existing) return existing;
        throw new ToolError("REFUND_NOT_ELIGIBLE", "This payment has already been fully refunded.", false, { reasonCode: "ALREADY_REFUNDED" });
      }
      throw err;
    }
  }

  private async issueInTransaction(
    ctx: ToolExecutionContext, key: string, paymentId: string, requestedAmountCents: number | undefined, account: AccountFacts, policy: RefundPolicyLookup,
  ): Promise<RefundRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const payment = await this.payments.getById(paymentId, client, true);
      if (!payment) throw new ToolError("ACCESS_DENIED", "That payment was not found on your account.");

      const raced = await this.findByKey(key, paymentId, ctx.customerId!, requestedAmountCents, client);
      if (raced) {
        await client.query("commit");
        return raced;
      }
      const evaluation = evaluateRefund(this.buildFacts(ctx, payment, account, policy, requestedAmountCents));
      if (!evaluation.eligible) throw evaluationToError(evaluation);

      const amount = requestedAmountCents ?? evaluation.refundableCents;
      const { rows } = await client.query<RefundRow>(
        `insert into refunds (payment_id, customer_id, amount_cents, currency, idempotency_key, session_id, run_id)
         values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [payment.id, payment.customerId, amount, payment.currency, key, ctx.sessionId, ctx.runId],
      );
      await client.query("update payments set refunded_cents = refunded_cents + $2 where id = $1", [payment.id, amount]);
      await this.audit.log({
        sessionId: ctx.sessionId, customerId: payment.customerId, actor: "agent", action: "refund.issued", entityType: "payment", entityId: payment.id,
        previousValue: { refundedCents: payment.refundedCents }, newValue: { refundedCents: payment.refundedCents + amount, refundId: rows[0]!.id },
      }, client);
      await client.query("commit");
      return toRecord(rows[0]!, false);
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async loadAccount(customerId: string): Promise<AccountFacts> {
    const [customer, subscription, contract] = await Promise.all([
      this.customers.getById(customerId), this.subscriptions.getForCustomer(customerId), this.contracts.getForCustomer(customerId),
    ]);
    return { customer, subscription, contract };
  }

  private async lookupPolicy(account: AccountFacts): Promise<RefundPolicyLookup> {
    if (!account.subscription) return { available: false, sources: [] };
    return this.policy.resolve(account.subscription.tier, account.contract?.type ?? account.subscription.billingPeriod);
  }

  private buildFacts(
    ctx: ToolExecutionContext,
    payment: PaymentRecord,
    { customer, subscription, contract }: AccountFacts,
    policy: RefundPolicyLookup,
    requestedAmountCents: number | undefined,
  ): RefundFacts {
    return {
      identityVerified: ctx.identityVerified,
      sessionCustomerId: ctx.customerId,
      payment,
      customerStatus: customer?.status ?? "suspended",
      subscription: subscription && { tier: subscription.tier, billingPeriod: subscription.billingPeriod, status: subscription.status },
      contract: contract && { type: contract.type, status: contract.status },
      requestedAmountCents,
      now: new Date(),
      policyAvailable: policy.available,
      maxAutoRefundCents: Math.round(this.env.MAX_AUTO_REFUND_USD * 100),
    };
  }

  private async findByKey(key: string, paymentId: string, customerId: string, amountCents?: number, db: Pick<pg.Pool, "query"> = this.pool): Promise<RefundRecord | null> {
    const { rows } = await db.query<RefundRow>("select * from refunds where idempotency_key = $1", [key]);
    const r = rows[0];
    if (!r) return null;
    if (r.payment_id !== paymentId || r.customer_id !== customerId || (amountCents !== undefined && amountCents !== r.amount_cents)) {
      throw new ToolError("IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different refund request.");
    }
    return toRecord(r, true);
  }
}
