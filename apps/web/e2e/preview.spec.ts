import { test, expect } from "@playwright/test";

test("markdown file preview shows heading", async ({ page }) => {
  await page.goto("/workspace");
  await page.getByText("README.md").click();
  await expect(page.getByRole("heading", { name: /Demo/i })).toBeVisible();
});

test("branch diff scope shows diff markers", async ({ page }) => {
  await page.goto("/workspace");
  await page.getByRole("button", { name: /Diff view off/i }).click();
  await page.getByRole("button", { name: /^src$/ }).click();
  await page.getByText("App.tsx").click();
  await page.getByRole("button", { name: /^branch$/i }).click();
  await expect(page.locator("pre").filter({ hasText: "+" }).first()).toBeVisible();
});
