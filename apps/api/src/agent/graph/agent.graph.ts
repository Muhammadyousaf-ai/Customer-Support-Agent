import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { END, START, StateGraph } from "@langchain/langgraph";
import { createBuildContextNode } from "../nodes/build-context.node.js";
import { createClarificationNode } from "../nodes/clarification.node.js";
import { createConfirmationNode } from "../nodes/confirmation.node.js";
import { createDecisionNode } from "../nodes/decision.node.js";
import { createEscalationNode } from "../nodes/escalation.node.js";
import { createEvaluateResultNode } from "../nodes/evaluate-result.node.js";
import { createExecuteToolNode } from "../nodes/execute-tool.node.js";
import { createFinalizeNode } from "../nodes/finalize.node.js";
import { createInitializeNode } from "../nodes/initialize.node.js";
import type { AgentDeps } from "../nodes/node-deps.js";
import { createRecoveryNode } from "../nodes/recovery.node.js";
import { createValidateToolNode } from "../nodes/validate-tool.node.js";
import { createVerifyResponseNode } from "../nodes/verify-response.node.js";
import { AgentState } from "../state/agent-state.js";
import { withSpan } from "../../observability/tracing/tracing.js";
import { afterConfirmation, afterDecision, afterEvaluate, afterValidate, afterVerify } from "./graph.router.js";

/**
 *   START -> initialize -> build_context -> llm_decision --(router)--> validate_tool -> execute_tool -> evaluate_result -+
 *                                  ^                |                        |  \-> request_confirmation (interrupt) -/  |
 *                                  +----------------+------------------------+------------------------------------------+
 *                                                   +-> verify_response -> finalize | escalate | back to llm_decision
 *                                                   +-> request_clarification -> finalize      recover -> finalize
 * The loop returns to llm_decision after every tool result, so the model adapts to what actually happened.
 */
/** Every graph node runs inside a span, so the waterfall shows the real sequence of nodes and what each one cost. */
const GUARDRAIL_NODES = new Set(["validate_tool", "verify_response", "request_confirmation"]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traced = <F extends (...a: any[]) => Promise<any>>(name: string, fn: F): F =>
  ((...a: Parameters<F>) => withSpan(`node.${name}`, { category: GUARDRAIL_NODES.has(name) ? "guardrail" : "agent", attrs: { node: name } }, () => fn(...a))) as F;

export function buildAgentGraph(deps: AgentDeps, checkpointer: BaseCheckpointSaver) {
  return new StateGraph(AgentState)
    .addNode("initialize", traced("initialize", createInitializeNode(deps)))
    .addNode("build_context", traced("build_context", createBuildContextNode(deps)))
    .addNode("llm_decision", traced("llm_decision", createDecisionNode(deps)))
    .addNode("validate_tool", traced("validate_tool", createValidateToolNode(deps)))
    .addNode("execute_tool", traced("execute_tool", createExecuteToolNode(deps)))
    .addNode("evaluate_result", traced("evaluate_result", createEvaluateResultNode(deps)))
    .addNode("request_clarification", traced("request_clarification", createClarificationNode(deps)))
    .addNode("request_confirmation", traced("request_confirmation", createConfirmationNode(deps)))
    .addNode("verify_response", traced("verify_response", createVerifyResponseNode(deps)))
    .addNode("escalate", traced("escalate", createEscalationNode(deps)))
    .addNode("recover", traced("recover", createRecoveryNode(deps)))
    .addNode("finalize", traced("finalize", createFinalizeNode(deps)))
    .addEdge(START, "initialize")
    .addEdge("initialize", "build_context")
    .addEdge("build_context", "llm_decision")
    .addConditionalEdges("llm_decision", afterDecision, ["validate_tool", "verify_response", "request_clarification", "escalate", "recover", "finalize", "llm_decision"])
    .addConditionalEdges("validate_tool", afterValidate, ["request_confirmation", "execute_tool", "evaluate_result", "recover", "finalize"])
    .addConditionalEdges("request_confirmation", afterConfirmation, ["execute_tool", "llm_decision", "recover", "finalize"])
    .addEdge("execute_tool", "evaluate_result")
    .addConditionalEdges("evaluate_result", afterEvaluate, ["llm_decision", "recover", "finalize"])
    .addConditionalEdges("verify_response", afterVerify, ["finalize", "escalate", "llm_decision"])
    .addEdge("request_clarification", "finalize")
    .addEdge("escalate", "finalize")
    .addEdge("recover", "finalize")
    .addEdge("finalize", END)
    .compile({ checkpointer });
}

export type AgentGraph = ReturnType<typeof buildAgentGraph>;
