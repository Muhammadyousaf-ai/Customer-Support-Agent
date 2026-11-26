import { expect, type Page } from "@playwright/test";

/** The AI assistant requires an account, so every chat/voice/observability spec signs in as the seeded demo customer first. */
export async function signInAsCustomer(page: Page, email = "customer@example.com") {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("demo-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/customer\/tickets/);
}
