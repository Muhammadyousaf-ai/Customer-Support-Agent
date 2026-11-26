import { z } from "zod";
import { TOOL_NAMES } from "@support-ai/contracts";
import type { LlmResponse, LlmToolDef } from "../providers/llm-provider.interface.js";

/**
 * The model's structured decision. Business tools use native function calling; routing decisions are four extra
 * "control" functions, so every model turn yields exactly one machine-readable decision.
 */
export type AgentDecision =
  | { type: "tool_call"; toolCallId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: "respond"; toolCallId?: string; response: string; sourceIds: string[] }
  | { type: "clarify"; toolCallId?: string; question: string; requiredFields: string[] }
  | { type: "confirm_action"; toolCallId: string; toolName: string; arguments: Record<string, unknown>; message: string }
  | { type: "escalate"; toolCallId?: string; reason: string; category: string; summary: string };

export const CONTROL = {
  respond: "respond_to_customer",
  clarify: "ask_customer_for_info",
  confirm: "request_customer_confirmation",
  escalate: "escalate_to_human",
} as const;

const respondArgs = z.object({ response: z.string().min(1).max(4000), sourceIds: z.array(z.string()).default([]) });
const clarifyArgs = z.object({ question: z.string().min(1).max(1000), requiredFields: z.array(z.string()).default([]) });
const confirmArgs = z.object({ toolName: z.string(), arguments: z.record(z.string(), z.unknown()).default({}), message: z.string().default("") });
const escalateArgs = z.object({ reason: z.string().min(1).max(500), category: z.string().default("other"), summary: z.string().min(1).max(1000) });

export const controlToolDefs = (): LlmToolDef[] => [
  {
    name: CONTROL.respond,
    description:
      "Send your final answer to the customer. Use this only when you have what you need. Cite the ids of the retrieved policy sources (sourceIds) that support any policy claim. Never state that an action succeeded unless a tool result confirmed it.",
    parameters: { type: "object", properties: { response: { type: "string" }, sourceIds: { type: "array", items: { type: "string" } } }, required: ["response", "sourceIds"] },
  },
  {
    name: CONTROL.clarify,
    description: "Ask the customer for missing information (for example their email and verification code, or which payment they mean).",
    parameters: { type: "object", properties: { question: { type: "string" }, requiredFields: { type: "array", items: { type: "string" } } }, required: ["question"] },
  },
  {
    name: CONTROL.confirm,
    description:
      "Propose a sensitive action (issue_refund or update_account) so the customer can confirm it. The backend creates the confirmation itself; you do not need to write the amounts.",
    parameters: {
      type: "object",
      properties: { toolName: { type: "string", enum: ["issue_refund", "update_account"] }, arguments: { type: "object" }, message: { type: "string" } },
      required: ["toolName", "arguments"],
    },
  },
  {
    name: CONTROL.escalate,
    description: "Hand the case to a human agent when it is out of scope, unsupported by policy, needs approval, or cannot be resolved with the available tools.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" }, category: { type: "string", enum: ["billing", "refund", "account", "technical", "other"] }, summary: { type: "string" } },
      required: ["reason", "category", "summary"],
    },
  },
];

export type ParsedDecision = { ok: true; decision: AgentDecision } | { ok: false; error: string; toolCallId?: string };

export function parseDecision(res: LlmResponse): ParsedDecision {
  const call = res.toolCalls[0];
  if (!call) {
    const text = res.content?.trim();
    // A model that ignores function calling and just answers is treated as a plain response with no sources,
    // which the verification guardrail will then scrutinise.
    return text ? { ok: true, decision: { type: "respond", response: text, sourceIds: [] } } : { ok: false, error: "The model produced neither a tool call nor an answer." };
  }
  let args: unknown;
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    return { ok: false, error: `The arguments for ${call.name} were not valid JSON.`, toolCallId: call.id };
  }
  const bad = (e: z.ZodError) => ({ ok: false as const, error: `Invalid arguments for ${call.name}: ${z.prettifyError(e)}`, toolCallId: call.id });
  switch (call.name) {
    case CONTROL.respond: {
      const r = respondArgs.safeParse(args);
      return r.success ? { ok: true, decision: { type: "respond", toolCallId: call.id, ...r.data } } : bad(r.error);
    }
    case CONTROL.clarify: {
      const r = clarifyArgs.safeParse(args);
      return r.success ? { ok: true, decision: { type: "clarify", toolCallId: call.id, ...r.data } } : bad(r.error);
    }
    case CONTROL.confirm: {
      const r = confirmArgs.safeParse(args);
      return r.success ? { ok: true, decision: { type: "confirm_action", toolCallId: call.id, ...r.data } } : bad(r.error);
    }
    case CONTROL.escalate: {
      const r = escalateArgs.safeParse(args);
      return r.success ? { ok: true, decision: { type: "escalate", toolCallId: call.id, ...r.data } } : bad(r.error);
    }
    default: {
      if (!(TOOL_NAMES as readonly string[]).includes(call.name)) {
        return { ok: false, error: `"${call.name}" is not an available tool.`, toolCallId: call.id };
      }
      if (typeof args !== "object" || args === null || Array.isArray(args)) return { ok: false, error: `Arguments for ${call.name} must be a JSON object.`, toolCallId: call.id };
      return { ok: true, decision: { type: "tool_call", toolCallId: call.id, toolName: call.name, arguments: args as Record<string, unknown> } };
    }
  }
}
