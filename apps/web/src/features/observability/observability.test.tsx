import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ErrorInspector } from "./components/errors/error-inspector";
import { GuardrailInspector } from "./components/guardrails/guardrail-inspector";
import { HistoryList } from "./components/history-list";
import { ModelInvocationView, PromptInspector } from "./components/prompts/prompt-inspector";
import { RetrievalInspector } from "./components/retrieval/retrieval-inspector";
import { RunOverview } from "./components/run-overview";
import { ExecutionTimeline } from "./components/timeline/execution-timeline";
import { layoutRows } from "./components/timeline/waterfall-chart";
import { ToolInspector } from "./components/tools/tool-inspector";
import { UsagePanel } from "./components/usage/usage-panel";
import { VoiceDiagnosticsPanel } from "./components/voice/voice-diagnostics";
import { useObservabilityStore } from "./store/observability.store";
import type { ModelInvocation, Overview, Span, UsageInfo } from "./types";

const span = (id: string, parent: string | null, name: string, start: number, dur: number, category: Span["category"] = "agent", extra: Partial<Span> = {}): Span => ({
  spanId: id, traceId: "t", parentSpanId: parent, name, category, startOffsetMs: start, startedAt: "2026-11-25T10:00:00Z", durationMs: dur, status: "ok", errorCode: null, attributes: {}, ...extra,
});
const SPANS = [
  span("a", null, "agent.run", 0, 1000),
  span("b", "a", "node.llm_decision", 10, 400),
  span("c", "b", "llm.decision", 12, 390, "llm", { detail: { purpose: "decision" } }),
  span("d", "a", "node.execute_tool", 420, 300),
  span("e", "d", "tool.get_subscription", 425, 80, "tool"),
  span("f", "d", "tool.get_contract", 430, 90, "tool"), // parallel with e
];
const usage = (over: Partial<UsageInfo["totals"]> = {}): UsageInfo => ({
  models: [{ model: "gpt-4.1-mini", calls: 2, inputTextTokens: 1200, outputTextTokens: 400, cachedInputTokens: 800, thinkingTokens: 0, totalTokens: 2400, costUsd: "0.002460", sources: ["provider_reported"] }],
  embedding: { tokens: 0, model: null, cost: null },
  totals: { inputTokens: 2000, outputTokens: 400, totalTokens: 2400, embeddingTokens: 0, modelCalls: 2, estimatedCostUsd: "0.002460", partialCostUsd: "0.002460", costComplete: true, costNotes: [], pricingVersions: ["gpt-4.1-mini@2026-11-25"], label: "Estimated API cost. Excludes free-tier credits, discounts and taxes.", ...over },
});
const overview = (over: Partial<Overview> = {}): Overview => ({
  runId: "run_1", mode: "chat", status: "completed", provider: "openai", traceId: "a".repeat(32),
  metrics: { endToEndProcessingMs: 3420, wallClockMs: 9000, customerWaitMs: 5580, segments: 2, timeToFirstStatusMs: 80, userVisibleTtftMs: 2900, modelTtftMs: null, modelCalls: 4, modelMs: 2100, toolCalls: 7, toolFailures: 1, retries: 1, retrievalAttempts: 1, guardrailFailures: 0 },
  usage: usage().totals, grounding: { topSimilarity: 0.93, evidenceVerified: true }, voice: null, observability: { degraded: false, dropped: 0, queued: 0 }, ...over,
});

beforeEach(() => useObservabilityStore.setState({ selectedRunId: null, tab: "overview", selectedSpanId: null, hiddenCategories: [] }));

describe("run overview", () => {
  it("shows real latency, tokens, cost, tools and similarity, and separates customer wait from processing", () => {
    render(<RunOverview o={overview()} />);
    expect(screen.getByTestId("m-latency-value")).toHaveTextContent("3.42 s");
    expect(screen.getByTestId("m-latency")).toHaveTextContent("plus 5.58 s waiting for the customer");
    expect(screen.getByTestId("m-tokens-value")).toHaveTextContent("2,400");
    expect(screen.getByTestId("m-cost-value")).toHaveTextContent("$0.002460");
    expect(screen.getByTestId("m-tools")).toHaveTextContent("6 succeeded · 1 failed · 1 retries");
    expect(screen.getByTestId("m-retrieval-value")).toHaveTextContent("0.93");
    expect(screen.getByTestId("m-ttft")).toHaveTextContent("not observable");
  });
  it("never renders an unknown cost as $0 and says why", () => {
    render(<RunOverview o={overview({ usage: usage({ estimatedCostUsd: null, costComplete: false, costNotes: ["No pricing configured for some-model on 2026-11-25."] }).totals })} />);
    expect(screen.getByTestId("m-cost-value")).toHaveTextContent("Unavailable");
    expect(screen.getByTestId("m-cost")).not.toHaveTextContent("$0");
    expect(screen.getByTestId("m-cost")).toHaveTextContent("No pricing configured");
  });
  it("flags degraded observability without implying the workflow failed", () => {
    render(<RunOverview o={overview({ observability: { degraded: true, dropped: 12, queued: 0 } })} />);
    expect(screen.getByTestId("obs-degraded")).toHaveTextContent("support workflow is unaffected");
  });
  it("shows time to first audio for voice runs", () => {
    render(<RunOverview o={overview({ mode: "voice", metrics: { ...overview().metrics, timeToFirstAudioMs: 2410 } })} />);
    expect(screen.getByTestId("m-audio-value")).toHaveTextContent("2.41 s");
  });
});

describe("execution timeline", () => {
  it("lays spans out by parent, preserving overlap (parallel tools) and depth", () => {
    const rows = layoutRows(SPANS);
    expect(rows.map((r) => [r.span.name, r.depth])).toEqual([["agent.run", 0], ["node.llm_decision", 1], ["llm.decision", 2], ["node.execute_tool", 1], ["tool.get_subscription", 2], ["tool.get_contract", 2]]);
    const e = SPANS[4]!, f = SPANS[5]!;
    expect(e.startOffsetMs + e.durationMs).toBeGreaterThan(f.startOffsetMs); // the two tools genuinely overlap
  });
  it("selecting a span shows its category, offset, duration and (for admins) its detail", () => {
    render(<ExecutionTimeline spans={SPANS} restricted={false} />);
    fireEvent.click(screen.getAllByTestId("span-row").find((r) => r.dataset.span === "llm.decision")!);
    const d = screen.getByTestId("span-details");
    expect(d).toHaveTextContent("llm.decision");
    expect(within(d).getByTestId("span-duration")).toHaveTextContent("390 ms");
    expect(within(d).getByTestId("span-detail")).toHaveTextContent('"purpose": "decision"');
  });
  it("hides span detail from restricted viewers", () => {
    render(<ExecutionTimeline spans={SPANS} restricted />);
    fireEvent.click(screen.getAllByTestId("span-row")[2]!);
    expect(screen.queryByTestId("span-detail")).toBeNull();
    expect(screen.getByTestId("restricted")).toBeInTheDocument();
  });
  it("filters by operation type", () => {
    render(<ExecutionTimeline spans={SPANS} restricted={false} />);
    expect(screen.getAllByTestId("span-row")).toHaveLength(6);
    fireEvent.click(screen.getByTestId("filter-tool"));
    expect(screen.getAllByTestId("span-row").map((r) => r.dataset.category)).not.toContain("tool");
    expect(screen.getAllByTestId("span-row")).toHaveLength(4);
  });
  it("marks failed spans in text, not only by styling", () => {
    render(<ExecutionTimeline spans={[span("x", null, "tool.issue_refund", 0, 50, "tool", { status: "error", errorCode: "TOOL_TIMEOUT" })]} restricted={false} />);
    expect(screen.getByTestId("span-row")).toHaveTextContent("(failed)");
  });
});

const model = (over: Partial<ModelInvocation> = {}): ModelInvocation => ({
  invocationId: "inv_1", index: 1, spanId: "c", purpose: "decision", provider: "openai", model: "gpt-4.1-mini", promptVersion: "sha256:abc123def456", durationMs: 680, finishReason: "stop", status: "ok", errorCode: null,
  usageSource: "provider_reported", usage: { inputTextTokens: 600, outputTextTokens: 200, cachedInputTokens: 400, thinkingTokens: 50, totalTokens: 1200 }, estimatedCostUsd: "0.001230", costStatus: "ok", costNote: null, pricingVersion: "gpt-4.1-mini@2026-11-25",
  systemPrompt: "You are a customer support agent for SupportAI.", messages: [{ role: "user", content: "Refund my payment, code [CODE-1]" }], tools: [{ name: "get_payment_history", description: "d" }], output: { toolCalls: [{ name: "get_payment_history" }] }, ...over,
});

describe("prompt inspector", () => {
  it("shows the system prompt, input, tools and output of a model call with its metadata", () => {
    render(<PromptInspector models={[model()]} />);
    expect(screen.getByTestId("model-invocation")).toHaveTextContent("gpt-4.1-mini");
    expect(screen.getByTestId("model-invocation")).toHaveTextContent("680 ms");
    expect(screen.getByTestId("model-invocation")).toHaveTextContent("$0.001230");
    expect(screen.getByTestId("model-invocation")).toHaveTextContent("sha256:abc123def456");
    expect(screen.getByTestId("prompt-system")).toHaveTextContent("customer support agent");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Input" }), { button: 0 });
    expect(screen.getByTestId("prompt-input")).toHaveTextContent("[CODE-1]");
  });
  it("labels estimated usage and unavailable cost honestly", () => {
    render(<ModelInvocationView m={model({ usageSource: "estimated", estimatedCostUsd: null, costStatus: "unavailable", costNote: "No pricing configured for x." })} />);
    expect(screen.getByTestId("model-invocation")).toHaveTextContent("estimated (provider reported no usage)");
    expect(screen.getByTestId("model-invocation")).toHaveTextContent("Unavailable");
    expect(screen.getByTestId("model-invocation")).toHaveTextContent("No pricing configured");
  });
  it("withholds prompt content from a restricted viewer but still shows metadata", () => {
    render(<ModelInvocationView m={model({ restricted: true, systemPrompt: undefined, messages: undefined })} />);
    expect(screen.getByTestId("restricted")).toBeInTheDocument();
    expect(screen.queryByTestId("prompt-system")).toBeNull();
    expect(screen.getByTestId("model-invocation")).toHaveTextContent("680 ms");
  });
  it("switches between the calls of a run", () => {
    render(<PromptInspector models={[model(), model({ invocationId: "inv_2", index: 2, purpose: "evidence_check", systemPrompt: "Check the evidence." })]} />);
    fireEvent.click(screen.getAllByTestId("model-call-button")[1]!);
    expect(screen.getByTestId("model-invocation").dataset.purpose).toBe("evidence_check");
    expect(screen.getByTestId("prompt-system")).toHaveTextContent("Check the evidence.");
  });
});

describe("tool inspector", () => {
  const tool = { executionId: "e1", tool: "issue_refund", type: "write", status: "success" as const, attempts: 1, retries: 0, durationMs: 120, errorCode: null, errorKind: null, committed: true, parentModelInvocation: "inv_1" };
  it("shows that a write really committed, with the sanitized arguments and result", () => {
    render(<ToolInspector tools={[{ ...tool, args: { paymentId: "PAY-002" }, result: { refundId: "REF-001", simulated: true } }]} />);
    expect(screen.getByTestId("tool-committed")).toHaveTextContent("Committed");
    expect(screen.getByTestId("tool-result")).toHaveTextContent("REF-001");
    expect(screen.getByTestId("tool-args")).toHaveTextContent("PAY-002");
  });
  it("describes a policy rejection as a rejection, not a malfunction, and hides data from restricted viewers", () => {
    render(<ToolInspector tools={[{ ...tool, status: "failed", errorCode: "REFUND_NOT_ELIGIBLE", errorKind: "business_rule", committed: false, restricted: true }]} />);
    expect(screen.getByTestId("tool-record")).toHaveTextContent("Rejected by policy (REFUND_NOT_ELIGIBLE)");
    expect(screen.getByTestId("tool-committed")).toHaveTextContent("Not committed");
    expect(screen.queryByTestId("tool-args")).toBeNull();
  });
});

describe("retrieval, guardrails, usage, voice, errors, history", () => {
  it("shows every candidate with its similarity against the threshold, and the evidence outcome", () => {
    const c = (n: string, s: number) => ({ chunkId: n, document: `${n}.md`, heading: n, similarity: s });
    render(<RetrievalInspector retrievals={[{ attempt: 1, durationMs: 230, query: "refund for my last payment", topK: 5, threshold: 0.8, status: "grounded", evidenceVerified: true, confidenceScore: 0.94, filters: { tier: "pro", contractType: "monthly" }, embedding: { embeddingModel: "text-embedding-3-small" }, accepted: [c("Monthly Refund Policy", 0.94)], rejected: [c("Account Management", 0.31)], stages: [{ name: "rag.embed_query", durationMs: 120 }] }]} />);
    expect(screen.getAllByTestId("candidate").map((x) => x.dataset.accepted)).toEqual(["true", "false"]);
    expect(screen.getByTestId("evidence-outcome")).toHaveTextContent("Passed");
    expect(screen.getByTestId("retrieval-attempt")).toHaveTextContent("tier: pro");
    expect(screen.getByTestId("retrieval-attempt")).toHaveTextContent("0.8");
  });
  it("explains guardrail outcomes in words", () => {
    render(<GuardrailInspector g={{ results: [{ sequence: 1, event: "guardrail.failed", guardrail: "evidence_verification", status: "failed", reasonCode: "no supporting passage", action: "escalate" }], nodes: [{ node: "verify_response", durationMs: 40, status: "ok" }] }} />);
    expect(screen.getByTestId("guardrail-result")).toHaveTextContent("Evidence verification");
    expect(screen.getByTestId("guardrail-result")).toHaveTextContent("no supporting passage");
  });
  it("breaks usage down per model and prints the estimate label", () => {
    render(<UsagePanel u={usage()} />);
    expect(screen.getByTestId("usage-row")).toHaveTextContent("gpt-4.1-mini");
    expect(screen.getByTestId("usage-row")).toHaveTextContent("$0.002460");
    expect(screen.getByTestId("usage-panel")).toHaveTextContent("Estimated API cost. Excludes free-tier credits");
  });
  it("shows a partial total as partial when some calls are unpriced", () => {
    render(<UsagePanel u={usage({ estimatedCostUsd: null, costComplete: false, partialCostUsd: "0.001000" })} />);
    expect(screen.getByTestId("u-cost")).toHaveTextContent("Unavailable");
    expect(screen.getByTestId("u-cost")).toHaveTextContent("Partial: $0.001000");
  });
  it("renders voice diagnostics including session-level cost attribution", () => {
    render(<VoiceDiagnosticsPanel d={{ voiceSessionId: "vs1", status: "ended", model: "gpt-realtime-mini", endReason: "client_end", metrics: { connectionSetupMs: 840, timeToFirstAudioMs: 2410, timeToFirstPlaybackMs: 2530, interruptionLatencyMs: 180, rttMs: 76, reconnectAttempts: 0, droppedFrames: 0, interruptions: 2 }, cost: { estimatedCostUsd: "0.012400", pricingVersion: "gpt-realtime-mini@2026-11-25", attribution: "session" }, audioSeconds: { input: 32, output: 18 }, turns: [{ turnId: "t1", runId: "r", interrupted: true, grounding: "verified", firstAudioMs: 2410 }], functionCalls: { total: 3, duplicates: 0 }, events: [] }} />);
    expect(screen.getByTestId("v-setup-value")).toHaveTextContent("840 ms");
    expect(screen.getByTestId("v-first-audio-value")).toHaveTextContent("2.41 s");
    expect(screen.getByTestId("voice-cost")).toHaveTextContent("$0.012400");
    expect(screen.getByTestId("voice-cost")).toHaveTextContent("session-level");
    expect(screen.getByTestId("voice-turn")).toHaveTextContent("yes");
  });
  it("separates infrastructure failures from business-rule rejections", () => {
    render(<ErrorInspector e={{ errors: [{ category: "authorization", kind: "business_rule", code: "ACCESS_DENIED", message: null, at: "t" }, { category: "timeout", kind: "infrastructure", code: "TOOL_TIMEOUT", message: "timed out", at: "t" }], retries: [{ tool: "search_knowledge_base", attempts: 2, finalErrorCode: null, recovered: true }], summary: { infrastructure: 1, businessRule: 1, guardrail: 0 } }} />);
    expect(screen.getByTestId("error-summary")).toHaveTextContent("1 infrastructure failure · 1 business-rule rejection");
    expect(screen.getAllByTestId("error-item").map((x) => x.dataset.kind)).toEqual(["business_rule", "infrastructure"]);
    expect(screen.getByTestId("retry-item")).toHaveTextContent("recovered");
  });
  it("lists previous runs and selects one", () => {
    let picked = "";
    render(<HistoryList runs={[{ runId: "r2", mode: "voice", status: "completed", startedAt: "2026-11-25T10:00:00Z", finishedAt: null, request: "Refund?", processingMs: 2100, modelCalls: 3, toolCalls: 4, tokens: 100, estimatedCostUsd: null, costComplete: false }]} selectedId={null} onSelect={(id) => { picked = id; }} />);
    expect(screen.getByTestId("history-run")).toHaveTextContent("voice · completed · 2.10 s · 4 tools · Unavailable");
    fireEvent.click(screen.getByTestId("history-run"));
    expect(picked).toBe("r2");
  });
});
