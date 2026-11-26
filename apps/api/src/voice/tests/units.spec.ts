import { VOICE_AUDIO_HEADER_BYTES, decodeAudioFrame, encodeAudioFrame } from "@support-ai/contracts";
import { describe, expect, it } from "vitest";
import { AudioOutputGate } from "../audio/audio-output-gate.js";
import { InputBudget, validateInputFrame } from "../audio/audio-validation.js";
import { FunctionCallHandler } from "../delegation/function-call-handler.js";
import { SUPPORT_TOOL_NAME } from "../delegation/support-tool.definition.js";
import { affirms, verifyGrounding } from "../grounding/grounding-verifier.js";
import { maskCodes } from "../voice-connection.js";

describe("audio frames", () => {
  it("round-trips the generation/sequence header", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const frame = encodeAudioFrame(7, 42, pcm);
    expect(frame.byteLength).toBe(VOICE_AUDIO_HEADER_BYTES + 4);
    const d = decodeAudioFrame(frame)!;
    expect([d.generationId, d.sequence, [...d.pcm]]).toEqual([7, 42, [1, 2, 3, 4]]);
    expect(decodeAudioFrame(new Uint8Array(4))).toBeNull();
  });
  it("rejects malformed microphone frames", () => {
    expect(validateInputFrame(new Uint8Array(1280)).ok).toBe(true);
    expect(validateInputFrame(new Uint8Array(0))).toEqual({ ok: false, reason: "empty" });
    expect(validateInputFrame(new Uint8Array(1281))).toEqual({ ok: false, reason: "odd_length" });
    expect(validateInputFrame(new Uint8Array(7000))).toEqual({ ok: false, reason: "too_large" });
  });
  it("limits input to the configured byte rate", () => {
    let t = 0;
    const b = new InputBudget(1000, () => t);
    expect(b.take(800)).toBe(true);
    expect(b.take(800)).toBe(false);
    t += 1000;
    expect(b.take(800)).toBe(true);
  });
});

describe("audio output gate", () => {
  it("blocks audio until a verified answer opens it for that turn only", () => {
    const g = new AudioOutputGate();
    expect(g.admit("t1", 100)).toBe(false);
    g.open("t1");
    expect(g.admit("t1", 100)).toBe(true);
    expect(g.admit("t2", 100)).toBe(false);
    g.close();
    expect(g.admit("t1", 100)).toBe(false);
    expect(g.stats()).toEqual({ gatedBytes: 300, gatedFrames: 3 });
  });
});

describe("grounding verifier", () => {
  const ok = (approved: string, spoken: string) => verifyGrounding(approved, `${spoken} `).ok;
  it("accepts a faithful paraphrase", () => {
    expect(ok("Your $49.00 payment is eligible for a refund. Shall I go ahead?", "Your 49 dollar payment is eligible for a refund. Shall I go ahead?")).toBe(true);
  });
  it.each([
    ["Refund requires manual approval.", "Your refund has been approved."],
    ["I could not verify your identity.", "Great, your account has been verified."],
    ["Your $49 payment is eligible. Shall I go ahead? (yes/no)", "Your refund has been completed."],
    ["I couldn't create a support ticket right now.", "Your support ticket has been created."],
    ["Your $49 payment is eligible.", "I can refund 100 dollars for you."],
  ])("flags %s -> %s", (approved, spoken) => {
    expect(ok(approved, spoken)).toBe(false);
  });
  it("does not treat negated or conditional wording as a claim", () => {
    expect(affirms("not verified", /\bverified\b/gi)).toBe(false);
    expect(ok("Your refund REF-001 of $49 has been processed.", "Your refund REF-001 of $49 has been processed.")).toBe(true);
    expect(ok("It will be processed once you confirm.", "It will be processed once you confirm.")).toBe(true);
  });
  it("ignores a trailing partial word", () => {
    expect(verifyGrounding("Pending your confirmation.", "Your refund has been approv").ok).toBe(true);
  });
});

describe("function call handler", () => {
  const call = (id: string, args: unknown = { request: "refund" }) => ({ id, name: SUPPORT_TOOL_NAME, args: args as Record<string, unknown> });

  it("rejects unsupported tools and invalid arguments without executing", async () => {
    let runs = 0;
    const h = new FunctionCallHandler(async () => { runs++; return { ok: true }; }, 1000);
    expect((await h.handle({ id: "1", name: "issue_refund", args: {} }, { turnId: "t" }))!.response).toEqual({ success: false, error: "UNSUPPORTED_TOOL" });
    expect((await h.handle(call("2", { request: "" }), { turnId: "t" }))!.response.error).toBe("INVALID_ARGUMENTS");
    expect((await h.handle(call("3", { request: "x", customerId: "CUST-009" }), { turnId: "t" }))!.response.error).toBe("INVALID_ARGUMENTS"); // the model cannot choose the account
    expect(runs).toBe(0);
  });
  it("executes once per call id and once per turn", async () => {
    let runs = 0;
    let dups = 0;
    const h = new FunctionCallHandler(async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return { n: runs }; }, 1000, { onDuplicate: () => dups++ });
    const [a, b, c] = await Promise.all([h.handle(call("a"), { turnId: "t1" }), h.handle(call("a"), { turnId: "t1" }), h.handle(call("b"), { turnId: "t1" })]);
    // the same call id is answered once; a different id in the same turn gets the shared result
    expect([a!.response, b, c!.response]).toEqual([{ n: 1 }, null, { n: 1 }]);
    expect(runs).toBe(1);
    expect(dups).toBe(2);
  });
  it("times out with a structured, speakable error", async () => {
    const h = new FunctionCallHandler(() => new Promise(() => undefined), 30);
    const r = await h.handle(call("a"), { turnId: "t" });
    expect(r!.response).toMatchObject({ success: false, error: "TIMEOUT" });
  });
  it("turns an exception into a structured error", async () => {
    const h = new FunctionCallHandler(async () => { throw new Error("boom"); }, 1000);
    expect((await h.handle(call("a"), { turnId: "t" }))!.response).toMatchObject({ success: false, error: "INTERNAL" });
  });
  it("discards the result of a cancelled call", async () => {
    const h = new FunctionCallHandler(async (_t, _r, onRun) => { onRun("run_1"); await new Promise((r) => setTimeout(r, 30)); return { done: true }; }, 1000);
    const p = h.handle(call("a"), { turnId: "t" });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.cancel(["a"])).toEqual([{ id: "a", turnId: "t", runId: "run_1" }]);
    expect(await p).toBeNull();
  });
});

describe("transcript masking", () => {
  it("masks spoken verification codes, spaced or not", () => {
    expect(maskCodes("my code is 482910")).toBe("my code is [CODE]");
    expect(maskCodes("code 4 8 2 9 1 0 thanks")).toBe("code [CODE] thanks");
    expect(maskCodes("refund 49 dollars")).toBe("refund 49 dollars");
  });
});
