import { Module } from "@nestjs/common";
import type { Env } from "../config/env.js";
import { ENV } from "../config/tokens.js";
import { AuditService } from "../audit/audit.service.js";
import { ContractsService } from "../contracts/contracts.service.js";
import { CustomersService } from "../customers/customers.service.js";
import { EscalationsService } from "../escalations/escalations.service.js";
import { PaymentsService } from "../payments/payments.service.js";
import { RagModule } from "../rag/rag.module.js";
import { RefundPolicyService } from "../refunds/refund-policy.service.js";
import { RefundsService } from "../refunds/refunds.service.js";
import { SessionsService } from "../sessions/sessions.service.js";
import { SubscriptionsService } from "../subscriptions/subscriptions.service.js";
import { CreateEscalationTool } from "./escalation/create-escalation.tool.js";
import { ToolEventsService } from "./events/tool-events.service.js";
import { GetPaymentHistoryTool } from "./payments/get-payment-history.tool.js";
import { UpdateAccountTool } from "./account/update-account.tool.js";
import { VerifyIdentityTool } from "./identity/verify-identity.tool.js";
import { SearchKnowledgeBaseTool } from "./knowledge/search-knowledge-base.tool.js";
import { AuthorizationService } from "./middleware/authorization.service.js";
import { IdempotencyService } from "./middleware/idempotency.service.js";
import { RetryService } from "./middleware/retry.service.js";
import { TimeoutService } from "./middleware/timeout.service.js";
import { CheckRefundEligibilityTool } from "./refund/check-refund-eligibility.tool.js";
import { IssueRefundTool } from "./refund/issue-refund.tool.js";
import { ExecutionLogService } from "./registry/execution-log.service.js";
import { ToolContextService } from "./registry/tool-context.service.js";
import { EXECUTION_LOG, TOOLS, TOOL_CONTEXT_BUILDER, TOOL_RUNTIME_CONFIG } from "./registry/tool-definition.interface.js";
import { ToolExecutor } from "./registry/tool-executor.service.js";
import { ToolRegistry } from "./registry/tool-registry.service.js";
import { FailureSimulator } from "./simulation/failure-simulator.service.js";
import { GetContractTool } from "./subscription/get-contract.tool.js";
import { GetSubscriptionTool } from "./subscription/get-subscription.tool.js";

const TOOL_CLASSES = [
  VerifyIdentityTool, GetSubscriptionTool, GetContractTool, GetPaymentHistoryTool, SearchKnowledgeBaseTool,
  CheckRefundEligibilityTool, IssueRefundTool, UpdateAccountTool, CreateEscalationTool,
];

/** Business services live in their own folders; this module wires them to the tools and the executor. */
@Module({
  imports: [RagModule],
  providers: [
    SessionsService, AuditService, CustomersService, SubscriptionsService, ContractsService, PaymentsService,
    RefundPolicyService, RefundsService, EscalationsService,
    AuthorizationService, IdempotencyService, RetryService, TimeoutService, ToolEventsService, FailureSimulator,
    ExecutionLogService, ToolContextService,
    { provide: EXECUTION_LOG, useExisting: ExecutionLogService },
    { provide: TOOL_CONTEXT_BUILDER, useExisting: ToolContextService },
    { provide: TOOL_RUNTIME_CONFIG, useFactory: (env: Env) => ({ retryBaseDelayMs: env.TOOL_RETRY_BASE_DELAY_MS }), inject: [ENV] },
    ...TOOL_CLASSES,
    { provide: TOOLS, useFactory: (...tools: unknown[]) => tools, inject: TOOL_CLASSES },
    ToolRegistry,
    ToolExecutor,
  ],
  exports: [ToolExecutor, ToolRegistry, ToolEventsService, SessionsService, FailureSimulator, CustomersService, SubscriptionsService, ContractsService],
})
export class ToolsModule {}
