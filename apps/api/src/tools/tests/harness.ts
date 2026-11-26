import type { ToolResult } from "@support-ai/contracts";
import pg from "pg";
import { AuditService } from "../../audit/audit.service.js";
import { loadEnv } from "../../config/env.js";
import { ContractsService } from "../../contracts/contracts.service.js";
import { CustomersService } from "../../customers/customers.service.js";
import { pool } from "../../database/pool.js";
import { seedDatabase } from "../../database/seed-data.js";
import { EscalationsService } from "../../escalations/escalations.service.js";
import { PaymentsService } from "../../payments/payments.service.js";
import { ChunkingService } from "../../rag/chunking/chunking.service.js";
import { ConfidenceService } from "../../rag/confidence/confidence.service.js";
import { HeuristicEvidenceVerifier } from "../../rag/confidence/heuristic-verifier.js";
import { EmbeddingService } from "../../rag/embeddings/embedding.service.js";
import { LocalHashEmbedder } from "../../rag/embeddings/local-hash.embedder.js";
import { IngestionService } from "../../rag/ingestion/ingestion.service.js";
import { RagService } from "../../rag/rag.service.js";
import { DocumentRepository } from "../../rag/repositories/document.repository.js";
import { RankingService } from "../../rag/retrieval/ranking.service.js";
import { RetrievalService } from "../../rag/retrieval/retrieval.service.js";
import { testConfig } from "../../rag/tests/helpers.js";
import { RefundPolicyService, type RefundPolicyLookup } from "../../refunds/refund-policy.service.js";
import { RefundsService } from "../../refunds/refunds.service.js";
import { SessionsService } from "../../sessions/sessions.service.js";
import { SubscriptionsService } from "../../subscriptions/subscriptions.service.js";
import { UpdateAccountTool } from "../account/update-account.tool.js";
import { CreateEscalationTool } from "../escalation/create-escalation.tool.js";
import { ToolEventsService } from "../events/tool-events.service.js";
import { VerifyIdentityTool } from "../identity/verify-identity.tool.js";
import { SearchKnowledgeBaseTool } from "../knowledge/search-knowledge-base.tool.js";
import { AuthorizationService } from "../middleware/authorization.service.js";
import { IdempotencyService } from "../middleware/idempotency.service.js";
import { RetryService } from "../middleware/retry.service.js";
import { TimeoutService } from "../middleware/timeout.service.js";
import { GetPaymentHistoryTool } from "../payments/get-payment-history.tool.js";
import { CheckRefundEligibilityTool } from "../refund/check-refund-eligibility.tool.js";
import { IssueRefundTool } from "../refund/issue-refund.tool.js";
import { ExecutionLogService } from "../registry/execution-log.service.js";
import { ToolContextService } from "../registry/tool-context.service.js";
import type { ToolDefinition } from "../registry/tool-definition.interface.js";
import { ToolExecutor } from "../registry/tool-executor.service.js";
import { ToolRegistry } from "../registry/tool-registry.service.js";
import { FailureSimulator } from "../simulation/failure-simulator.service.js";
import { GetContractTool } from "../subscription/get-contract.tool.js";
import { GetSubscriptionTool } from "../subscription/get-subscription.tool.js";

export { pool };

/** Demo credentials from seed-data.ts */
export const SARAH = { email: "sarah@example.com", code: "482910", id: "CUST-002" };
export const ALEX = { email: "alex.morgan@example.com", code: "401923", id: "CUST-001" };
export const JAMES = { email: "james.miller@example.com", code: "730156", id: "CUST-003" };
export const EMMA = { email: "emma.davis@example.com", code: "915284", id: "CUST-004" };
export const OLIVIA = { email: "olivia.smith@example.com", code: "557392", id: "CUST-006" };

export const dbAvailable = await pool.query("select 1 from refunds limit 1").then(() => true, () => false);

/** Manual wiring of the real services, tools and executor (no Nest container) against the real database. */
export function buildHarness(opts: { policy?: RefundPolicyLookup | "real"; timeoutOverrideMs?: number; poolMax?: number } = {}) {
  const env = loadEnv({});
  /** A small private pool lets tests prove nothing deadlocks when concurrency exceeds connections. */
  const db = opts.poolMax ? new pg.Pool({ connectionString: env.DATABASE_URL, max: opts.poolMax }) : pool;
  const store = new DocumentRepository(db);
  const embeddings = new EmbeddingService(new LocalHashEmbedder());
  const rag = new RagService(
    embeddings, new RetrievalService(store, new RankingService(), testConfig), new ConfidenceService(testConfig),
    new HeuristicEvidenceVerifier(), store, testConfig, env,
  );
  const ingestion = new IngestionService(store, new ChunkingService(), embeddings, testConfig);

  const sessions = new SessionsService(db);
  const audit = new AuditService(db);
  const customers = new CustomersService(db, sessions, audit);
  const subscriptions = new SubscriptionsService(db);
  const contracts = new ContractsService(db);
  const payments = new PaymentsService(db);
  const policy =
    !opts.policy || opts.policy === "real"
      ? new RefundPolicyService(rag)
      : ({ resolve: async () => opts.policy } as unknown as RefundPolicyService);
  const refunds = new RefundsService(db, env, payments, customers, subscriptions, contracts, policy, audit);
  const escalations = new EscalationsService(db, subscriptions, audit);
  const auth = new AuthorizationService();

  const tools = [
    new VerifyIdentityTool(customers), new GetSubscriptionTool(subscriptions, auth), new GetContractTool(contracts, auth),
    new GetPaymentHistoryTool(payments, auth), new SearchKnowledgeBaseTool(rag, subscriptions, contracts),
    new CheckRefundEligibilityTool(refunds), new IssueRefundTool(refunds), new UpdateAccountTool(customers), new CreateEscalationTool(escalations),
  ] as ToolDefinition[];
  const registry = new ToolRegistry(tools);
  const events = new ToolEventsService();
  const simulator = new FailureSimulator(env);
  const executor = new ToolExecutor(
    registry, new ToolContextService(sessions), auth, new IdempotencyService(), new TimeoutService(), new RetryService(), events, simulator,
    new ExecutionLogService(db), { retryBaseDelayMs: 1, timeoutOverrideMs: opts.timeoutOverrideMs },
  );

  let n = 0;
  /** New backend session + run, optionally verified as a demo customer through the real verify_identity tool. */
  async function session(as?: { email: string; code: string }) {
    const s = await sessions.create();
    const runId = await sessions.startRun(s.id);
    const run = (tool: string, input: unknown, extra: { idempotencyKey?: string } = {}) =>
      executor.execute({ tool, input, sessionId: s.id, runId, toolCallId: `call_${++n}`, ...extra });
    if (as) {
      const v = await run("verify_identity", { email: as.email, verificationCode: as.code });
      if (!v.success) throw new Error(`test setup: verification failed: ${v.error?.message}`);
    }
    return { sessionId: s.id, runId, run };
  }

  return { pool: db, close: () => (db === pool ? Promise.resolve() : db.end()), customers, subscriptions, contracts, env, rag, ingestion, sessions, registry, events, simulator, executor, session, reset: () => seedDatabase(pool) };
}

export type Harness = ReturnType<typeof buildHarness>;

export const errorOf = (r: ToolResult<unknown>) => r.error;
export const dataOf = <T>(r: ToolResult<unknown>) => r.data as T;

export async function count(table: string, where = "true", params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query(`select count(*)::int as n from ${table} where ${where}`, params);
  return rows[0].n;
}
