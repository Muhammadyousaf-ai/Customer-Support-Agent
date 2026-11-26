import { expect, test } from "@playwright/test";
import { assistant, refundCount, reseed, sql, startVerifiedConversation, startVoice } from "./voice-helpers";
import { signInAsCustomer } from "./auth-helpers";

test.beforeEach(() => reseed());

test("chat -> voice -> chat: a refund proposed by voice is confirmed with the chat card, one refund, one shared history", async ({ page }) => {
  await startVerifiedConversation(page);
  await startVoice(page);

  // The fake microphone "says" the refund request at ~2 s. Captions, processing and the agent's live tool steps appear.
  await expect(page.getByTestId("voice-status")).toHaveAttribute("data-activity", /user_speaking|processing/);
  await expect(page.locator('[data-testid="transcript-line"][data-role="user"]').first()).toContainText("Can you refund my last payment?");
  await expect(page.getByTestId("voice-status")).toHaveAttribute("data-activity", "processing");
  await expect(page.locator('[data-tool="get_payment_history"]')).toBeVisible(); // shared SSE tool indicators
  await expect(page.getByTestId("voice-status")).toHaveAttribute("data-activity", "assistant_speaking");
  await expect(page.locator('[data-testid="transcript-line"][data-role="assistant"]').last()).toContainText("go ahead");

  // The Phase 5 confirmation card is available in voice mode, and nothing is refunded yet.
  const card = page.getByTestId("confirmation-card");
  await expect(card).toBeVisible();
  expect(refundCount()).toBe(0);

  // Voice messages are in the same persisted history as the chat messages.
  await expect(page.locator('[data-testid="message"][data-mode="voice"]')).toHaveCount(2);

  // Observability: voice diagnostics are available next to the shared agent trace.
  await page.getByTestId("observability-toggle").click();
  await page.getByTestId("obs-tab-voice").click();
  await expect(page.getByTestId("v-setup-value")).toHaveText(/\d+ ms|\d\.\d+ s/);
  await expect(page.getByTestId("voice-cost")).toContainText("Unavailable"); // the scripted voice model has no configured price
  await expect(page.getByTestId("voice-turn").first()).toBeVisible();
  await page.getByTestId("observability-toggle").click();

  // Back to chat: end voice, then confirm with the card.
  await page.getByTestId("voice-end").click();
  await expect(page.getByTestId("voice-workspace")).toHaveCount(0);
  await expect(card).toBeVisible(); // pending action survives leaving voice
  await card.getByRole("button", { name: "Confirm refund" }).click();
  await expect(page.getByTestId("refund-reference")).toHaveText("REF-001");
  expect(refundCount()).toBe(1);

  // Backend facts: one voice run, the browser reported real playback, resources were closed.
  expect(sql("select count(*) from agent_runs where mode = 'voice'")).toBe("1");
  expect(sql("select count(*) from messages where mode = 'voice' and role = 'user'")).toBe("1");
  expect(Number(sql("select (metrics->>'timeToFirstPlaybackMs') is not null from voice_usage")  === "t" ? 1 : 0)).toBe(1);
  expect(sql("select status from voice_sessions")).toBe("ended");
  await expect(page.locator("body")).not.toContainText("482910");
});

test("voice confirmation: saying yes after the assistant finishes confirms the pending refund exactly once", async ({ page }) => {
  await startVerifiedConversation(page);
  await startVoice(page);
  await expect(page.getByTestId("confirmation-card")).toBeVisible();
  expect(refundCount()).toBe(0);

  // The second scripted utterance ("Yes") comes at ~16 s, after the assistant has stopped talking.
  await expect(page.getByTestId("refund-reference")).toHaveText("REF-001", { timeout: 45_000 });
  await expect(page.locator('[data-testid="transcript-line"][data-role="assistant"]').last()).toContainText("REF-001");
  expect(refundCount()).toBe(1);
  await expect(page.getByTestId("confirmation-card")).toHaveCount(0);
  // "Yes" resumes the paused run (it does not start a second one): one voice run, two spoken customer messages.
  expect(sql("select count(*) from agent_runs where mode = 'voice'")).toBe("1");
  expect(sql("select count(*) from messages where mode = 'voice' and role = 'user'")).toBe("2");

  // Mute and unmute are independent of the conversation.
  await page.getByTestId("voice-mute").click();
  await expect(page.getByTestId("voice-status")).toContainText("Muted");
  await page.getByTestId("voice-mute").click();
  await expect(page.getByTestId("voice-status")).not.toContainText("Muted");
  await page.getByTestId("voice-toggle").click();
  await expect(page.getByTestId("voice-workspace")).toHaveCount(0);
});

test("leaving the conversation page releases voice and the session ends", async ({ page }) => {
  await startVerifiedConversation(page);
  await startVoice(page);
  await signInAsCustomer(page);
  await page.goto("/support");
  await expect.poll(() => sql("select status from voice_sessions order by started_at desc limit 1"), { timeout: 30_000 }).toBe("ended");
});
