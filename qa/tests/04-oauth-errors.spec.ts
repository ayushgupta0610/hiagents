import { test, expect } from "@playwright/test";
import { APP_URL } from "../playwright.config";

// Exercise the OAuth error paths without actually going through Google.
// Each case hits /oauth/callback with a crafted query string and asserts
// we render the styled error card (not a bare <p>...</p>) + the right
// "Back to sign in" CTA. This is the regression suite for commits d313c55
// (Google-error handling) and 5d657e1 (fail-open onboarding).

test.describe("OAuth error pages (/oauth/callback)", () => {
  test("Google ?error=access_denied shows styled access-blocked card", async ({ page }) => {
    const response = await page.goto(
      `${APP_URL}/oauth/callback?error=access_denied&error_description=user+denied`,
      { waitUntil: "load" },
    );
    expect(response?.status()).toBe(400);
    // Page title
    await expect(page).toHaveTitle(/Google didn't let us in.*hiagents/);
    // Card title
    await expect(page.getByRole("heading", { name: /Google didn't let us in/i })).toBeVisible();
    // The test-users hint should be present (most-likely cause)
    await expect(page.getByText(/test[-\s]?users list/i)).toBeVisible();
    // Back CTA points to login (signin flow inferred from missing state)
    const back = page.getByRole("link", { name: /Back to sign in/i });
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute("href", "/admin/login");
  });

  test("?error=admin_policy_enforced explains the Workspace-admin gate", async ({ page }) => {
    await page.goto(`${APP_URL}/oauth/callback?error=admin_policy_enforced`);
    await expect(page.getByRole("heading", { name: /workspace admin blocked/i })).toBeVisible();
    await expect(page.getByText(/Google Workspace administrator/i)).toBeVisible();
  });

  test("?error=consent_required shows 'try again' card", async ({ page }) => {
    await page.goto(`${APP_URL}/oauth/callback?error=consent_required`);
    await expect(page.getByRole("heading", { name: /Sign-in incomplete/i })).toBeVisible();
  });

  test("unknown error code falls back to a styled page that echoes the code", async ({ page }) => {
    await page.goto(`${APP_URL}/oauth/callback?error=xyzzy_fake_error`);
    await expect(page.getByRole("heading", { name: /Sign-in failed/i })).toBeVisible();
    // The code should be echoed back so an operator can grep logs
    await expect(page.getByText(/xyzzy_fake_error/)).toBeVisible();
  });

  test("missing state nonce + no error shows expired-link card", async ({ page, context }) => {
    await context.clearCookies();
    await page.goto(`${APP_URL}/oauth/callback?code=fake&state=login:fakenonce`);
    // Without the hiagents_oauth_state cookie, state-nonce check fails first.
    await expect(page.getByRole("heading", { name: /expired|invalid/i })).toBeVisible();
    // Back CTA still styled
    await expect(page.getByRole("link", { name: /Back to sign in/i })).toBeVisible();
  });

  test("mailbox-flow error routes the back-button to /admin (not /admin/login)", async ({ page }) => {
    await page.goto(
      `${APP_URL}/oauth/callback?error=access_denied&state=mailbox:fake-tenant-id:nonce`,
    );
    const back = page.getByRole("link", { name: /Back to dashboard/i });
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute("href", "/admin");
  });

  test("error page uses styled dark theme (not bare <p>)", async ({ page }) => {
    await page.goto(`${APP_URL}/oauth/callback?error=access_denied`);
    // The styled card has a body element with dark background. The bare
    // <p>...</p> regression would just be a white-default browser page.
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // rgb(7, 7, 10) = #07070a, the ink color in renderOAuthError. Anything
    // close to white means the styled page didn't render.
    const m = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)/);
    expect(m, "background should be parseable rgb").not.toBeNull();
    const [r, g, b] = m!.slice(1).map(Number);
    expect(r, "red channel should be ≤ 30 (dark)").toBeLessThanOrEqual(30);
    expect(g, "green channel should be ≤ 30 (dark)").toBeLessThanOrEqual(30);
    expect(b, "blue channel should be ≤ 30 (dark)").toBeLessThanOrEqual(30);
  });
});
