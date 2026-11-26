import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import { signInAsCustomer } from "./auth-helpers";

const ROOT = resolve(__dirname, "../../..");
export const login = "I'm sarah@example.com and my code is 482910.";
export const reseed = () => execFileSync("pnpm", ["--filter", "api", "db:seed"], { cwd: ROOT, stdio: "ignore" });
export const refundCount = () =>
  Number(execFileSync("docker", ["exec", "customer-issues-agent_db_1", "psql", "-U", "support", "-d", "support_ai_test", "-tAc", "select count(*) from refunds"]).toString().trim());
export const sql = (q: string) => execFileSync("docker", ["exec", "customer-issues-agent_db_1", "psql", "-U", "support", "-d", "support_ai_test", "-tAc", q]).toString().trim();

export const assistant = (page: Page) => page.locator('[data-testid="message"][data-role="assistant"]');

/** Starts a conversation and verifies the customer through chat, so voice starts from an authenticated session. */
export async function startVerifiedConversation(page: Page) {
  await signInAsCustomer(page);
  await page.goto("/support");
  await page.getByTestId("new-conversation").first().click();
  await page.getByTestId("composer-input").fill(`What subscription am I currently using? ${login}`);
  await page.getByTestId("send-button").click();
  await expect(assistant(page).last()).toContainText("pro plan");
}

export async function startVoice(page: Page) {
  await page.getByTestId("voice-toggle").click();
  await expect(page.getByTestId("voice-status")).toHaveAttribute("data-connection", "connected");
}
