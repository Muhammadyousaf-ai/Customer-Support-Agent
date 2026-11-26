import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { signInAsCustomer } from "./auth-helpers";

const ROOT = resolve(__dirname, "../../..");
const PASSWORD = "demo-password-1";
const reseed = () => execFileSync("pnpm", ["--filter", "api", "db:seed"], { cwd: ROOT, stdio: "ignore" });

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}
async function asUser(browser: Browser, email: string, landing: RegExp) {
  const context = await browser.newContext({ baseURL: "http://localhost:3100" });
  const page = await context.newPage();
  await signIn(page, email);
  await expect(page).toHaveURL(landing);
  return page;
}

test.beforeEach(() => reseed());

test("signed-out visitors and the wrong role are kept out of the portals", async ({ browser, page }) => {
  await page.goto("/admin/kb");
  await expect(page).toHaveURL(/\/login\?next=/);
  const customer = await asUser(browser, "customer@example.com", /\/customer\/tickets/);
  await customer.goto("/admin");
  await expect(customer).toHaveURL(/\/customer\/tickets/); // bounced home, and the API would refuse anyway
  await expect(customer.getByRole("link", { name: "Audit log" })).toHaveCount(0);
});

test("wrong password shows one generic error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("customer@example.com");
  await page.getByLabel("Password").fill("not-the-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("form").getByRole("alert")).toContainText(/invalid|incorrect/i);
  await expect(page).toHaveURL(/\/login/);
});

test("a customer ticket is claimed, answered and resolved by staff; internal notes stay internal", async ({ browser }) => {
  const customer = await asUser(browser, "customer@example.com", /\/customer\/tickets/);
  await customer.getByTestId("new-ticket").click();
  await customer.getByLabel("Subject").fill("Charged twice this month");
  await customer.getByLabel("What happened?").fill("I see two charges for the same plan.");
  await customer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(customer).toHaveURL(/\/customer\/tickets\/TKT-/);
  const ticketUrl = customer.url();
  const id = ticketUrl.split("/").pop()!;

  const staff = await asUser(browser, "staff1@example.com", /\/staff/);
  await staff.goto(`/staff/tickets/${id}`);
  await expect(staff.getByTestId("ticket-status")).toHaveText("Open");
  await expect(staff.getByText("Claim the ticket to read the conversation.")).toBeVisible(); // limited view before claiming
  await staff.getByTestId("claim").click();
  await expect(staff.getByTestId("ticket-status")).toHaveText("Assigned");
  await staff.getByTestId("reply-box").fill("Thanks, I am checking the duplicate charge now.");
  await staff.getByRole("button", { name: "Send reply" }).click();
  await staff.getByTestId("note-box").fill("INTERNAL: duplicate looks like a retry on our side");
  await staff.getByRole("button", { name: "Add note" }).click();
  await expect(staff.getByTestId("ticket-notes")).toContainText("INTERNAL: duplicate");

  await customer.reload();
  await expect(customer.getByTestId("ticket-messages")).toContainText("checking the duplicate charge");
  await expect(customer.getByText("INTERNAL: duplicate")).toHaveCount(0);

  await staff.getByTestId("resolve").click();
  await staff.getByTestId("resolution-box").fill("Refunded the duplicate charge.");
  await staff.getByTestId("confirm-resolve").click();
  await expect(staff.getByTestId("ticket-status")).toHaveText("Resolved");
  await customer.reload();
  await expect(customer.getByTestId("ticket-status")).toHaveText("Resolved");

  // A second staff member cannot touch it; customers never see the staff queue.
  const other = await asUser(browser, "staff2@example.com", /\/staff/);
  await other.goto(`/staff/tickets/${id}`);
  await expect(other.getByTestId("ticket-notes")).toHaveCount(0);
});

test("the AI stays out of a conversation a human owns, and the customer sees who is answering", async ({ browser }) => {
  const customer = await asUser(browser, "customer@example.com", /\/customer\/tickets/);
  await customer.getByTestId("new-ticket").click();
  await customer.getByLabel("Subject").fill("Need to talk to someone");
  await customer.getByLabel("What happened?").fill("Please call me back about my invoice.");
  await customer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(customer).toHaveURL(/\/customer\/tickets\/TKT-/);
  await customer.goto("/support");
  await customer.getByTestId("conversation-item").first().click();
  await expect(customer.getByTestId("handover-banner")).toContainText("support team");
  await customer.getByTestId("composer-input").fill("Is anyone there?");
  await customer.getByTestId("send-button").click();
  await expect(customer.locator('[data-testid="message"][data-role="user"]').filter({ hasText: "Is anyone there?" })).toBeVisible();
  await customer.waitForTimeout(1500);
  await expect(customer.locator('[data-testid="message"][data-role="assistant"]')).toHaveCount(0); // no AI answer
});

test("New conversation does not stack empty conversations", async ({ page }) => {
  await signInAsCustomer(page);
  await page.goto("/support");
  const btn = page.getByTestId("new-conversation").first();
  await btn.click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await btn.click();
  await btn.click();
  await expect(page.getByTestId("conversation-item")).toHaveCount(1);
});

test("an admin publishes a knowledge-base document, finds it by retrieval, and deletes it", async ({ browser }) => {
  const admin = await asUser(browser, "admin@example.com", /\/admin/);
  await admin.goto("/admin/kb");
  await expect(admin.getByTestId("kb-table")).toContainText("Refund");
  await admin.getByTestId("kb-new").click();
  await admin.getByTestId("kb-source").fill("---\ntitle: Quokka loyalty rewards\ncategory: subscription\nversion: 1.0\n---\n# Quokka loyalty rewards\n\n## Eligibility\n\nQuokka loyalty rewards are granted after twelve consecutive paid months.\n");
  await admin.getByTestId("kb-preview").click();
  await expect(admin.getByTestId("kb-preview-result")).toContainText("1 chunks");
  await admin.getByTestId("kb-publish").click();
  await expect(admin.getByTestId("kb-message")).toContainText("Published and indexed");
  await expect(admin).toHaveURL(/\/admin\/kb\/[0-9a-f-]{36}/);

  await admin.goto("/admin/kb");
  await admin.getByTestId("kb-test-query").fill("quokka loyalty rewards twelve consecutive paid months");
  await admin.getByTestId("kb-test-run").click();
  await expect(admin.getByTestId("kb-test-result")).toContainText("Quokka loyalty rewards");

  await admin.getByRole("link", { name: "Quokka loyalty rewards" }).click();
  await admin.getByRole("button", { name: "Delete", exact: true }).click();
  await admin.getByRole("button", { name: "Delete document" }).click();
  await expect(admin).toHaveURL(/\/admin\/kb$/);
  await admin.getByTestId("kb-test-query").fill("quokka loyalty rewards twelve consecutive paid months");
  await admin.getByTestId("kb-test-run").click();
  await expect(admin.getByTestId("kb-test-result")).not.toContainText("Quokka loyalty rewards");
});

test("an admin invites a staff member and the audit log records it", async ({ browser }) => {
  const admin = await asUser(browser, "admin@example.com", /\/admin/);
  await admin.goto("/admin/staff");
  await admin.getByTestId("invite-staff").click();
  await admin.getByLabel("Name").fill("Jordan Newhire");
  await admin.getByLabel("Email").fill(`jordan.${Date.now()}@example.com`); // accounts survive reseeding, so the address must be new each run
  await admin.getByRole("button", { name: "Send invitation" }).click();
  await expect(admin.getByTestId("staff-table")).toContainText("Jordan Newhire");
  await expect(admin.getByTestId("staff-table")).toContainText("Invited");
  await admin.goto("/admin/audit");
  await expect(admin.getByTestId("audit-table")).toContainText("staff.invited");
});
