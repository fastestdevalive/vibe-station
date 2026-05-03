import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.removeItem("viberun:workspace");
    } catch {
      /* ignore */
    }
  });
});

test("app boots and renders shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /toggle font/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /toggle theme/i })).toBeVisible();
});

test("theme toggle flips data-theme on <html>", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: /toggle theme/i }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
});

test("font toggle updates --font-family on root", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /toggle font/i }).click();
  const font = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--font-family"),
  );
  expect(font).toContain("sans");
});

test("layout toggle flips workspace data-terminal", async ({ page }) => {
  await page.goto("/worktree");
  const layout = page.locator("#workspace-layout");
  await expect(layout).toHaveAttribute("data-terminal", "left");
  await page.getByRole("button", { name: /terminal pane layout/i }).click();
  await expect(layout).toHaveAttribute("data-terminal", "bottom");
});

test("sidebar toggle updates data-sidebar", async ({ page }) => {
  await page.goto("/worktree");
  const layout = page.locator("#workspace-layout");
  await expect(layout).toHaveAttribute("data-sidebar", "open");
  await page.getByRole("button", { name: /Hide projects sidebar/i }).click();
  await expect(layout).toHaveAttribute("data-sidebar", "closed");
});

test("home shows dashboard overview when no worktree is selected", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Dashboard/i })).toBeVisible();
});

test("/dashboard redirects to workspace home", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL("/");
});
