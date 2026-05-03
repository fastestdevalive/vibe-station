import { test, expect } from "@playwright/test";

test("main tab visible for default worktree", async ({ page }) => {
  await page.goto("/worktree");
  await expect(page.getByRole("tab", { name: /^main$/i })).toBeVisible();
});

test("new tab dialog opens and cancel closes", async ({ page }) => {
  await page.goto("/worktree");
  await page.getByRole("button", { name: /New tab/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: /^Cancel$/i }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Modes menu opens from footer button", async ({ page }) => {
  await page.goto("/worktree");
  await page.getByRole("button", { name: /Modes/i }).click();
  await expect(page.getByRole("dialog", { name: /Modes/i })).toBeVisible();
});
