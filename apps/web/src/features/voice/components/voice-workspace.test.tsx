import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Input } from "@/components/ui/input";
import { initialVoiceState } from "../services/voice-event-reducer";
import type { VoiceState } from "../types";
import { describeVoice } from "./voice-status";
import { VoiceWorkspace } from "./voice-workspace";

const voice = (over: Partial<VoiceState>) => ({
  state: { ...initialVoiceState(), ...over }, active: true, start: vi.fn(), end: vi.fn(), setMuted: vi.fn(), setPushToTalk: vi.fn(), holdToTalk: vi.fn(), interrupt: vi.fn(), analyser: () => null,
});

describe("VoiceWorkspace", () => {
  it("holding Space anywhere talks in push-to-talk mode, but not while typing in a field", () => {
    const v = voice({ connectionStatus: "connected", pushToTalk: true });
    render(<><Input data-testid="field" /><VoiceWorkspace voice={v} /></>);
    fireEvent.keyDown(window, { code: "Space" });
    fireEvent.keyUp(window, { code: "Space" });
    expect(v.holdToTalk.mock.calls).toEqual([[true], [false]]);
    v.holdToTalk.mockClear();
    fireEvent.keyDown(screen.getByTestId("field"), { code: "Space" });
    expect(v.holdToTalk).not.toHaveBeenCalled();
  });

  it("renders nothing while voice is off", () => {
    const { container } = render(<VoiceWorkspace voice={voice({})} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows status, live captions and controls when connected", () => {
    render(<VoiceWorkspace voice={voice({ connectionStatus: "connected", activity: "user_speaking", partialUserTranscript: "Can you check my", transcript: [{ turnId: "t0", role: "assistant", text: "Hello", interrupted: true }] })} />);
    expect(screen.getByTestId("voice-status")).toHaveTextContent("Listening to you");
    const lines = screen.getAllByTestId("transcript-line");
    expect(lines.map((l) => l.dataset.partial)).toEqual(["false", "true"]);
    expect(screen.getByText("(interrupted)")).toBeInTheDocument();
    expect(screen.getByTestId("voice-mute")).toHaveTextContent("Mute");
    expect(screen.queryByTestId("voice-interrupt")).toBeNull();
  });

  it("offers Stop speaking only while the assistant speaks or works, and Unmute while muted", () => {
    render(<VoiceWorkspace voice={voice({ connectionStatus: "connected", activity: "assistant_speaking", isMuted: true })} />);
    expect(screen.getByTestId("voice-interrupt")).toBeInTheDocument();
    expect(screen.getByTestId("voice-mute")).toHaveTextContent("Unmute");
    expect(screen.getByTestId("voice-status")).toHaveTextContent("Muted");
  });

  it("explains a blocked microphone and always offers chat", () => {
    render(<VoiceWorkspace voice={voice({ connectionStatus: "failed", error: { code: "PERMISSION_DENIED", message: "Microphone access was blocked.", recoverable: true } })} />);
    expect(screen.getByTestId("voice-error")).toHaveTextContent("Microphone access was blocked.");
    expect(screen.getByText("Continue in chat")).toBeInTheDocument();
    expect(screen.queryByText("Try again")).toBeNull(); // retrying cannot help until the browser setting changes
  });

  it("shows reconnect progress", () => {
    expect(describeVoice({ ...initialVoiceState(), connectionStatus: "reconnecting", reconnectAttempts: 2, maxReconnectAttempts: 3 }).hint).toMatch(/2 of 3/);
  });
});
