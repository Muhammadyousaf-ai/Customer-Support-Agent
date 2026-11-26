import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { signInAsCustomer } from "./auth-helpers";

const ROOT = resolve(__dirname, "../../..");
const login = "I'm sarah@example.com and my code is 482910.";

/** Reseeds the database through the API workspace's own script (customers, payments, tickets all reset). */
const reseed = () => execFileSync("pnpm", ["--filter", "api", "db:seed"], { cwd: ROOT, stdio: "ignore" });

const assistant = (page: Page) => page.locator('[data-testid="message"][data-role="assistant"]');
const user = (page: Page) => page.locator('[data-testid="message"][data-role="user"]');

async function startConversation(page: Page) {
  await signInAsCustomer(page);
  await page.goto("/support");
  await page.getByTestId("new-conversation").first().click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
}
async function say(page: Page, text: string) {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("send-button").click();
}
const refundCount = () =>
  Number(execFileSync("docker", ["exec", "customer-issues-agent_db_1", "psql", "-U", "support", "-d", "support_ai_test", "-tAc", "select count(*) from refunds"]).toString().trim());

test.beforeEach(() => reseed());

test("refund: live tool indicators, confirmation card, then a result card from the backend", async ({ page }) => {
  await startConversation(page);
  await say(page, `I was charged yesterday but I barely use the app. Can I get my money back? ${login}`);

  // indicators are driven by real events and appear as the agent works
  const tools = page.getByTestId("tool-item");
  await expect(tools.first()).toBeVisible();
  await expect(page.locator('[data-tool="verify_identity"]')).toBeVisible();
  await expect(page.locator('[data-tool="get_payment_history"]')).toBeVisible();
  await expect(page.locator('[data-tool="search_knowledge_base"]')).toBeVisible();

  const card = page.getByTestId("confirmation-card");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("confirmation-amount")).toHaveText("$49.00");
  await expect(card).toContainText("PAY-002");
  await expect(page.getByTestId("refund-result")).toHaveCount(0); // never shown before the confirmed result
  expect(refundCount()).toBe(0);
  expect(await page.locator('[data-status="awaiting_confirmation"]').count()).toBeGreaterThan(0);

  await card.getByRole("button", { name: "Confirm refund" }).click();
  await expect(page.getByTestId("refund-reference")).toHaveText("REF-001");
  await expect(assistant(page).last()).toContainText("REF-001");
  await expect(page.getByTestId("policy-sources")).toContainText("Refund policy");
  await expect(page.getByTestId("confirmation-card")).toHaveCount(0);
  expect(refundCount()).toBe(1);
  // the customer's verification code never appears in the page
  await expect(page.locator("body")).not.toContainText("482910");
});

test("declining a refund creates no transaction", async ({ page }) => {
  await startConversation(page);
  await say(page, `Refund my last payment please. ${login}`);
  await page.getByTestId("confirmation-card").getByRole("button", { name: "Cancel" }).click();
  await expect(assistant(page).last()).toContainText("No problem");
  await expect(page.getByTestId("refund-result")).toHaveCount(0);
  expect(refundCount()).toBe(0);
});

test("unsupported request escalates and shows the ticket card", async ({ page }) => {
  await startConversation(page);
  await say(page, "Can you predict cryptocurrency prices?");
  await expect(page.getByTestId("ticket-id")).toHaveText("TKT-001");
  await expect(page.getByTestId("escalation-card")).toContainText("Open");
  await expect(assistant(page).last()).toContainText("TKT-001");
});

test("missing information produces a clarification question", async ({ page }) => {
  await startConversation(page);
  await say(page, "I want to change my account.");
  await expect(assistant(page).last()).toContainText("Which detail would you like to change");
  await expect(page.getByTestId("composer-input")).toBeEnabled();
});

test("a general policy question is answered from retrieved sources without verification", async ({ page }) => {
  await startConversation(page);
  await say(page, "What is your refund policy for monthly plans?");
  await expect(assistant(page).last()).toContainText("seven days");
  await expect(page.getByTestId("policy-sources")).toBeVisible();
  await expect(page.locator('[data-tool="verify_identity"]')).toHaveCount(0);
});

test("browser refresh while waiting for confirmation restores the card and does not duplicate the refund", async ({ page }) => {
  await startConversation(page);
  await say(page, `Refund my last payment please. ${login}`);
  await expect(page.getByTestId("confirmation-card")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("chat-title")).toBeVisible();
  await expect(user(page)).toHaveCount(1); // history restored from the backend, not duplicated
  await expect(page.getByTestId("confirmation-card")).toHaveCount(1);
  expect(refundCount()).toBe(0);

  await page.getByTestId("confirmation-card").getByRole("button", { name: "Confirm refund" }).click();
  await expect(page.getByTestId("refund-reference")).toHaveText("REF-001");

  await page.reload(); // refresh after the confirmation: the refund must not run again
  await expect(page.getByTestId("refund-result")).toHaveCount(1);
  await expect(page.getByTestId("confirmation-card")).toHaveCount(0);
  await page.waitForTimeout(800);
  expect(refundCount()).toBe(1);
});

test("a dropped connection is shown, reconnects automatically, and the run continues without repeating anything", async ({ page, context }) => {
  await startConversation(page);
  await say(page, `Refund my last payment please. ${login}`);
  await expect(page.getByTestId("confirmation-card")).toBeVisible();

  await context.setOffline(true); // Chrome fires the real "offline" event
  await expect(page.getByTestId("connection-status")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("connection-status")).toContainText("Previously completed actions will not be repeated");
  await context.setOffline(false);
  await expect(page.getByTestId("connection-status")).toHaveCount(0, { timeout: 30_000 });

  await page.getByTestId("confirmation-card").getByRole("button", { name: "Confirm refund" }).click();
  await expect(page.getByTestId("refund-reference")).toHaveText("REF-001");
  // events replayed after the reconnect must not duplicate rows: expand the finished run's steps and count
  const show = page.getByRole("button", { name: "Show agent steps" });
  if (await show.count()) await show.first().click(); // collapsed or already open, depending on how the run progressed
  await expect(page.locator('[data-testid="tool-item"][data-tool="issue_refund"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="tool-item"][data-tool="verify_identity"]')).toHaveCount(1);
  expect(refundCount()).toBe(1);
});

test("Stop cancels a running agent safely", async ({ page }) => {
  await startConversation(page);
  await say(page, "Please explain the slow refund policy"); // the dev model stalls on 'slow'
  await expect(page.getByTestId("stop-button")).toBeVisible();
  await page.getByTestId("stop-button").click();
  await expect(assistant(page).last()).toContainText("stopped");
  await expect(page.getByTestId("send-button")).toBeVisible();
  expect(refundCount()).toBe(0);
});

test("rapid double-click on Send submits one logical message", async ({ page }) => {
  await startConversation(page);
  await page.getByTestId("composer-input").fill("What is your refund policy for monthly plans?");
  await page.getByTestId("send-button").dblclick();
  await expect(assistant(page).last()).toContainText("seven days");
  await expect(user(page)).toHaveCount(1);
});

test("conversations are listed, renamed and switched with the right messages", async ({ page }) => {
  await startConversation(page);
  await say(page, "Can you predict cryptocurrency prices?");
  await expect(page.getByTestId("ticket-id")).toBeVisible();

  await page.getByTestId("new-conversation").first().click();
  await expect(page.getByTestId("empty-chat")).toBeVisible();
  await say(page, "What is your refund policy for monthly plans?");
  await expect(assistant(page).last()).toContainText("seven days");

  const items = page.getByTestId("conversation-item");
  await expect(items).toHaveCount(2);
  await items.nth(1).click(); // the older one: crypto
  await expect(assistant(page).last()).toContainText("TKT-001");
  await expect(page.getByTestId("empty-chat")).toHaveCount(0);

  await page.getByRole("button", { name: /^Rename Can you predict/ }).click({ force: true });
  await page.getByLabel("Conversation name").fill("Crypto question");
  await page.getByLabel("Conversation name").press("Enter");
  await expect(page.getByTestId("chat-title")).toHaveText("Crypto question");
  await page.reload();
  await expect(page.getByTestId("chat-title")).toHaveText("Crypto question");
});

test("a conversation whose token is no longer valid is dropped instead of retried forever", async ({ page }) => {
  await startConversation(page);
  await say(page, "hello");
  await expect(assistant(page).last()).toBeVisible();
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("support-ai:conversations")!);
    raw.state.items[0].token = "tampered";
    localStorage.setItem("support-ai:conversations", JSON.stringify(raw));
  });
  await page.reload();
  await expect(page.getByTestId("empty-chat")).toBeVisible();
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("responsive layout: sidebar becomes a slide-over, chat is usable, no horizontal scroll", async ({ page }) => {
    await signInAsCustomer(page);
    await page.goto("/support");
    await expect(page.getByTestId("conversation-list")).toBeHidden(); // desktop sidebar is hidden
    await page.getByRole("button", { name: "Open conversations" }).or(page.getByTestId("empty-chat")).first().waitFor();
    // start from the empty state, then verify the composer and cards fit
    await page.getByRole("button", { name: /What is your refund policy/ }).click();
    await expect(assistant(page).last()).toContainText("seven days", { timeout: 20_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    await page.getByRole("button", { name: "Open conversations" }).click();
    await expect(page.getByTestId("new-conversation").last()).toBeVisible();
  });
});
