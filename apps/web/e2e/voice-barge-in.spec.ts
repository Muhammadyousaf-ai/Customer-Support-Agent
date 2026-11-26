import { expect, test } from "@playwright/test";
import { reseed, startVerifiedConversation, startVoice, sql } from "./voice-helpers";

test.beforeEach(() => reseed());

test("barge-in: speaking over the assistant stops it, marks the answer interrupted, and the new request is handled", async ({ page }) => {
  await startVerifiedConversation(page);
  await startVoice(page);

  await expect(page.getByTestId("voice-status")).toHaveAttribute("data-activity", "assistant_speaking");
  // The fake microphone talks again at ~7.5 s, over the assistant ("Yes").
  await expect(page.locator('[data-testid="transcript-line"]').filter({ hasText: "(interrupted)" })).toBeVisible({ timeout: 30_000 });

  // The interruption was recorded server-side, the old audio was cleared and a newer generation is in use.
  await expect.poll(() => sql("select count(*) from voice_turns where interrupted"), { timeout: 20_000 }).not.toBe("0");
  expect(Number(sql("select count(*) from voice_events where type = 'voice.interrupted'"))).toBeGreaterThan(0);
  expect(sql("select count(*) from voice_events where type = 'voice.interrupted' and (payload->>'nextGenerationId')::int >= 2")).not.toBe("0");

  // The interrupting "Yes" was treated as the answer to the pending question: one refund, never two.
  await expect(page.getByTestId("refund-reference")).toHaveText("REF-001", { timeout: 30_000 });
  expect(sql("select count(*) from refunds")).toBe("1");
});
