import { expect, test, type Page } from "@playwright/test";
import { login, reseed } from "./voice-helpers";
import { signInAsCustomer } from "./auth-helpers";

const drawer = (p: Page) => p.getByTestId("observability-drawer");
const tab = (p: Page, t: string) => p.getByTestId(`obs-tab-${t}`).click();

test.beforeEach(() => reseed());

async function startRefund(page: Page) {
  await signInAsCustomer(page);
  await page.goto("/support");
  await page.getByTestId("new-conversation").first().click();
  await page.getByTestId("composer-input").fill(`Can you refund my last payment? ${login}`);
  await page.getByTestId("send-button").click();
  await expect(page.getByTestId("confirmation-card")).toBeVisible();
}

test("the drawer shows the real execution: metrics, waterfall, prompts, tools, retrieval, guardrails, usage and errors", async ({ page }) => {
  await startRefund(page);
  await page.getByTestId("observability-toggle").click();
  await expect(drawer(page)).toBeVisible();

  // Overview: real measurements. The scripted agent model has no configured price, so cost must say so instead of showing $0.
  await expect(page.getByTestId("m-latency-value")).toHaveText(/\d+(\.\d+)? (ms|s)/);
  await expect(page.getByTestId("m-tokens-value")).not.toHaveText("0");
  await expect(page.getByTestId("m-cost-value")).toHaveText("Unavailable");
  await expect(page.getByTestId("m-tools-value")).not.toHaveText("0");
  await expect(page.getByTestId("m-retrieval-value")).toHaveText(/0\.\d\d/);

  await tab(page, "timeline");
  await expect(page.locator('[data-testid="span-row"][data-span="agent.run"]')).toBeVisible();
  await expect(page.locator('[data-testid="span-row"][data-span="tool.get_payment_history"]')).toBeVisible();
  await page.locator('[data-testid="span-row"][data-span="tool.get_payment_history"]').click();
  await expect(page.getByTestId("span-details")).toContainText("tool.get_payment_history");
  await expect(page.getByTestId("span-duration")).toHaveText(/ms|s/);
  await page.getByTestId("filter-tool").click(); // hide tools
  await expect(page.locator('[data-testid="span-row"][data-category="tool"]')).toHaveCount(0);

  await tab(page, "prompts");
  await expect(page.getByTestId("prompt-system")).toContainText("customer support agent");
  await expect(page.getByTestId("model-invocation")).toContainText("e2e-scenario");
  await page.getByRole("tab", { name: "Tools" }).last().click();
  await expect(page.getByTestId("prompt-tools")).toContainText("get_payment_history");

  await tab(page, "tools");
  await expect(page.locator('[data-testid="tool-record"][data-tool="get_payment_history"]')).toBeVisible();
  const history = page.locator('[data-testid="tool-record"][data-tool="get_payment_history"]');
  await history.locator("summary").click();
  await expect(history.getByTestId("tool-result")).toContainText("PAY-002");

  await tab(page, "rag");
  await expect(page.getByTestId("retrieval-attempt").first()).toBeVisible();
  await expect(page.getByTestId("evidence-outcome").first()).toHaveText("Passed");
  await expect(page.getByTestId("candidate").first()).toBeVisible();

  await tab(page, "guardrails");
  await expect(page.getByTestId("guardrail-result").first()).toBeVisible();
  await tab(page, "usage");
  await expect(page.getByTestId("usage-row").first()).toContainText("e2e-scenario");
  await expect(page.getByTestId("usage-panel")).toContainText("Estimated API cost");
  await tab(page, "errors");
  await expect(page.getByTestId("error-summary")).toContainText("0 infrastructure failures");

  // The customer's verification code and full email never reach the page, even in the developer view.
  await expect(drawer(page)).not.toContainText("482910");
  await expect(drawer(page)).not.toContainText("sarah@example.com");
});

test("live: the drawer follows the run as it works and shows the committed refund without a reload; chat stays usable", async ({ page }) => {
  await startRefund(page);
  await page.getByTestId("observability-toggle").click();
  await tab(page, "tools");
  await expect(page.getByTestId("obs-run-label")).toContainText("live");
  await expect(page.locator('[data-testid="tool-record"][data-tool="issue_refund"]')).toHaveCount(0);

  await page.getByTestId("confirmation-card").getByRole("button", { name: "Confirm refund" }).click();
  await expect(page.getByTestId("refund-reference")).toHaveText("REF-001");
  await expect(page.locator('[data-testid="tool-record"][data-tool="issue_refund"]')).toBeVisible();
  const refund = page.locator('[data-testid="tool-record"][data-tool="issue_refund"]');
  await refund.locator("summary").click();
  await expect(refund.getByTestId("tool-committed")).toContainText("Committed");
  await expect(refund.getByTestId("tool-result")).toContainText("REF-001");

  // The same logical run: two execution segments, with the customer's thinking time reported separately.
  await tab(page, "overview");
  await expect(page.getByTestId("run-overview")).toContainText("2 execution segments");
  await expect(page.getByTestId("m-latency")).toContainText("waiting for the customer");

  // Chat is not blocked by the drawer.
  await page.getByTestId("composer-input").fill("What is your refund policy for monthly plans?");
  await page.getByTestId("send-button").click();
  await expect(page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText("refund", { ignoreCase: true });
  await page.getByTestId("observability-toggle").click();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeEnabled();
});

test("history: previous runs can be selected, and the trace survives a browser refresh", async ({ page }) => {
  await startRefund(page);
  await page.getByTestId("confirmation-card").getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText("haven't made any changes");
  await page.getByTestId("composer-input").fill("What is your refund policy for monthly plans?");
  await page.getByTestId("send-button").click();
  await expect(page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText("seven days", { ignoreCase: true });

  await page.getByTestId("observability-toggle").click();
  await tab(page, "history");
  const runs = page.getByTestId("history-run");
  await expect(runs).toHaveCount(2);
  await expect(runs.first()).toContainText("completed");
  await runs.nth(1).click(); // the earlier refund run
  await expect(page.getByTestId("obs-run-label")).not.toContainText("live");
  await expect(page.getByTestId("run-overview")).toBeVisible();
  await tab(page, "tools");
  await expect(page.locator('[data-testid="tool-record"][data-tool="get_payment_history"]')).toBeVisible();

  await page.reload();
  await page.getByTestId("observability-toggle").click();
  await expect(page.getByTestId("m-latency-value")).toHaveText(/\d/); // restored from PostgreSQL, not from memory
  await tab(page, "history");
  await expect(page.getByTestId("history-run")).toHaveCount(2);
});

test("a rejected action is shown as the guardrails working, not as a failure", async ({ page }) => {
  await signInAsCustomer(page);
  await page.goto("/support");
  await page.getByTestId("new-conversation").first().click();
  await page.getByTestId("composer-input").fill("Refund my last payment. I'm sarah@example.com and my code is 111111.");
  await page.getByTestId("send-button").click();
  await expect(page.locator('[data-testid="message"][data-role="assistant"]').last()).toBeVisible();
  await page.getByTestId("observability-toggle").click();
  await tab(page, "errors");
  await expect(page.getByTestId("error-summary")).toContainText("0 infrastructure failures");
  await expect(page.locator('[data-testid="error-item"][data-kind="business_rule"]').first()).toBeVisible();
  await expect(drawer(page)).not.toContainText("111111");
});
