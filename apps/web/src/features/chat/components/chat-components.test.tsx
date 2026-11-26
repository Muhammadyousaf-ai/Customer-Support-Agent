import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmationCard } from "@/features/actions/components/confirmation-card";
import { RefundResultCard } from "@/features/actions/components/refund-result-card";
import { AgentActivity } from "@/features/agent/components/agent-activity";
import { ErrorMessage } from "@/features/feedback/components/error-message";
import type { StoredMessage } from "../services/session.service";
import type { RunView } from "../types";
import { MessageBubble } from "./message-bubble";
import { MessageComposer } from "./message-composer";
import { MessageList } from "./message-list";

const run = (over: Partial<RunView> = {}): RunView => ({ runId: "r1", status: "processing", tools: [], sources: [], guardrails: [], streamingText: "", pendingAction: null, ...over });
const msg = (over: Partial<StoredMessage>): StoredMessage => ({ id: 1, role: "user", content: "hi", mode: "chat", runId: "r1", clientMessageId: null, createdAt: "t", ...over });
const noop = () => {};
const listProps = { acting: false, onConfirm: noop, onDecline: noop, onRetry: noop, runs: {}, activeRun: null, optimistic: [], messages: [] as StoredMessage[] };

describe("MessageBubble (safe markdown)", () => {
  it("renders markdown but never raw HTML, images, scripts or javascript: links", () => {
    const { container } = render(
      <MessageBubble role="assistant" content={'**Bold** and [ok](https://example.com) and [bad](javascript:alert(1))\n\n<script>alert(1)</script><img src=x onerror=alert(1)>\n\n![pic](https://evil.test/x.png)'} />,
    );
    expect(screen.getByText("Bold").tagName).toBe("STRONG");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    const links = [...container.querySelectorAll("a")];
    expect(links.find((a) => a.textContent === "ok")).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(links.find((a) => a.textContent === "bad")?.getAttribute("href") ?? "").toBe("");
  });
});

describe("AgentActivity", () => {
  it("renders whichever tools the agent used, with live statuses, retry and failure text", () => {
    render(
      <AgentActivity live run={run({ tools: [
        { id: "1", tool: "verify_identity", status: "completed", attempt: 1, durationMs: 85, startedSequence: 1 },
        { id: "2", tool: "brand_new_tool", status: "running", attempt: 1, startedSequence: 2 },
        { id: "3", tool: "get_contract", status: "retrying", attempt: 2, startedSequence: 3 },
        { id: "4", tool: "get_subscription", status: "failed", attempt: 1, errorCode: "ACCESS_DENIED", startedSequence: 4 },
        { id: "action:A", tool: "confirmation", status: "awaiting_confirmation", attempt: 1, detail: "Refund $49.00", startedSequence: 5 },
      ] })} />,
    );
    const items = screen.getAllByTestId("tool-item");
    expect(items.map((i) => i.getAttribute("data-status"))).toEqual(["completed", "running", "retrying", "failed", "awaiting_confirmation"]);
    expect(screen.getByText("Verified customer identity")).toBeInTheDocument();
    expect(screen.getByText("Brand new tool")).toBeInTheDocument(); // unknown tools still render, humanized
    expect(screen.getByText("85 ms")).toBeInTheDocument();
    expect(screen.getByText(/Retrying \(attempt 2\)/)).toBeInTheDocument();
    expect(screen.getByText("Failed: ACCESS_DENIED")).toBeInTheDocument();
    expect(screen.getByText("Awaiting your confirmation")).toBeInTheDocument();
    expect(screen.getByText("1 of 4 steps completed")).toBeInTheDocument();
  });

  it("collapses a finished run's steps behind a toggle", async () => {
    render(<AgentActivity live={false} run={run({ status: "completed", tools: [{ id: "1", tool: "get_contract", status: "completed", attempt: 1, durationMs: 3, startedSequence: 1 }] })} />);
    expect(screen.queryByTestId("tool-item")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /show agent steps/i }));
    expect(screen.getByTestId("tool-item")).toBeInTheDocument();
  });
});

describe("ConfirmationCard", () => {
  const action = { id: "ACT-1", type: "refund" as const, summary: "Refund", amountCents: 4900, currency: "USD", expiresAt: new Date(Date.now() + 600_000).toISOString(), display: { Customer: "CUST-002", "Payment reference": "PAY-002" } };

  it("shows the backend's details and sends confirm / decline", async () => {
    const onConfirm = vi.fn();
    const onDecline = vi.fn();
    render(<ConfirmationCard action={action} busy={false} onConfirm={onConfirm} onDecline={onDecline} />);
    expect(screen.getByTestId("confirmation-amount")).toHaveTextContent("$49.00");
    expect(screen.getByText("PAY-002")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirm refund" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it("disables both actions while a decision is in flight and when expired", () => {
    const { rerender } = render(<ConfirmationCard action={action} busy onConfirm={noop} onDecline={noop} />);
    expect(screen.getByRole("button", { name: /confirm refund/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    rerender(<ConfirmationCard action={{ ...action, expiresAt: new Date(Date.now() - 1000).toISOString() }} busy={false} onConfirm={noop} onDecline={noop} />);
    expect(screen.getByRole("button", { name: /confirm refund/i })).toBeDisabled();
    expect(screen.getByText(/expired/i)).toBeInTheDocument();
  });
});

describe("RefundResultCard", () => {
  it("shows the reference from the committed result and labels it simulated", () => {
    render(<RefundResultCard refund={{ refundId: "REF-001", paymentId: "PAY-002", amountCents: 4900, currency: "USD", simulated: true }} />);
    expect(screen.getByTestId("refund-reference")).toHaveTextContent("REF-001");
    expect(screen.getByText(/Simulated transaction/)).toBeInTheDocument();
  });
});

describe("MessageComposer", () => {
  it("sends on Enter, keeps Shift+Enter for new lines, and clears the draft", async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    render(<MessageComposer runStatus="idle" submitting={false} onSend={onSend} onStop={noop} />);
    const box = screen.getByLabelText("Message");
    await userEvent.type(box, "hello{Shift>}{Enter}{/Shift}world");
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.type(box, "{Enter}");
    expect(onSend).toHaveBeenCalledWith("hello\nworld");
    expect(box).toHaveValue("");
  });

  it("submits one logical message on a rapid double click", async () => {
    let finish!: (v: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((r) => (finish = r)));
    render(<MessageComposer runStatus="idle" submitting={false} onSend={onSend} onStop={noop} />);
    await userEvent.type(screen.getByLabelText("Message"), "refund please");
    const send = screen.getByRole("button", { name: "Send" });
    await userEvent.dblClick(send);
    expect(onSend).toHaveBeenCalledTimes(1);
    finish(true);
  });

  it("shows Stop (not Send) while the agent works and ignores Enter", async () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(<MessageComposer runStatus="processing" submitting={false} onSend={onSend} onStop={onStop} />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    await userEvent.type(screen.getByLabelText("Message"), "more{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalled();
  });

  it("keeps input enabled when the agent needs the customer", () => {
    render(<MessageComposer runStatus="awaiting_confirmation" submitting={false} onSend={noop as never} onStop={noop} />);
    expect(screen.getByLabelText("Message")).toBeEnabled();
    expect(screen.getByLabelText("Message")).toHaveAttribute("placeholder", expect.stringContaining("yes / no"));
  });
});

describe("MessageList reconciliation (no duplicates)", () => {
  it("shows an optimistic message once, until its persisted copy arrives", () => {
    const optimistic = [{ clientMessageId: "c1", content: "Can I get a refund?", status: "sent" as const }];
    const { rerender } = render(<MessageList {...listProps} optimistic={optimistic} />);
    expect(screen.getAllByText("Can I get a refund?")).toHaveLength(1);
    rerender(<MessageList {...listProps} optimistic={optimistic} messages={[msg({ id: 5, content: "Can I get a refund?", clientMessageId: "c1" })]} />);
    expect(screen.getAllByText("Can I get a refund?")).toHaveLength(1); // the persisted one replaced it
  });

  it("shows a streamed answer only until the persisted assistant message exists", () => {
    const streaming = run({ status: "streaming", streamingText: "Your refund is on its way.", finalText: "Your refund is on its way.", messageId: 9 });
    const { rerender } = render(<MessageList {...listProps} activeRun={streaming} runs={{ r1: streaming }} messages={[msg({ id: 8 })]} />);
    expect(screen.getByTestId("streaming-message")).toHaveTextContent("Your refund is on its way.");
    const done = { ...streaming, status: "completed" as const };
    rerender(<MessageList {...listProps} activeRun={done} runs={{ r1: done }} messages={[msg({ id: 8 }), msg({ id: 9, role: "assistant", content: "Your refund is on its way." })]} />);
    expect(screen.queryByTestId("streaming-message")).toBeNull();
    expect(screen.getAllByText("Your refund is on its way.")).toHaveLength(1);
  });

  it("renders the confirmation card exactly once, below the assistant's question, and result cards only from backend data", () => {
    const paused = run({ status: "awaiting_confirmation", pendingAction: { id: "ACT-1", type: "refund", summary: "Refund $49.00", amountCents: 4900, currency: "USD", expiresAt: new Date(Date.now() + 60000).toISOString(), display: {} } });
    render(<MessageList {...listProps} activeRun={paused} runs={{ r1: paused }} messages={[msg({ id: 1 }), msg({ id: 2, role: "assistant", content: "Refund $49.00. Shall I go ahead?" })]} />);
    expect(screen.getAllByTestId("confirmation-card")).toHaveLength(1);
    expect(screen.queryByTestId("refund-result")).toBeNull();
  });

  it("retries a failed send with the same client message id", async () => {
    const onRetry = vi.fn();
    render(<MessageList {...listProps} onRetry={onRetry} optimistic={[{ clientMessageId: "c9", content: "hello", status: "failed", error: { kind: "network", message: "Network error.", retryable: true } }]} />);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledWith("c9", "hello"));
  });
});

describe("ErrorMessage", () => {
  it("offers a safe retry for retryable errors and explains it will not duplicate", async () => {
    const onRetry = vi.fn();
    render(<ErrorMessage error={{ kind: "server", message: "The support agent is having trouble right now.", retryable: true }} onRetry={onRetry} />);
    expect(screen.getByText(/will not be processed twice/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });
  it("has no retry for non-retryable errors", () => {
    render(<ErrorMessage error={{ kind: "unauthorized", message: "Gone.", retryable: false }} onRetry={noop} />);
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});
