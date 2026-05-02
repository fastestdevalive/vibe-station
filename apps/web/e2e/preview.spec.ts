import { test, expect } from "@playwright/test";

test("markdown file preview shows heading", async ({ page }) => {
  await page.goto("/workspace");
  await page.getByText("README.md").click();
  await expect(page.getByRole("heading", { name: /Demo/i })).toBeVisible();
});

test("branch diff scope shows diff markers", async ({ page }) => {
  await page.goto("/workspace");
  const tree = page.getByRole("tree", { name: /Worktree files/i });
  await tree.getByRole("button", { name: /Expand folder/i }).click();
  await tree.getByText("App.tsx").click();
  await page.getByRole("radio", { name: /^branch$/i }).check();
  await expect(page.locator("pre").filter({ hasText: "+" }).first()).toBeVisible();
});
