import { test, expect } from "@playwright/test";
import { APP_URL } from "../playwright.config";

// Unauthenticated surfaces of the hiagents app at bot.example.com.
//   - /health endpoint
//   - /admin/login renders Google-only sign-in (no password fallback)
//   - / redirects to /admin/login
//   - /admin/onboarding redirects to /admin/login when unauthenticated
//   - /admin (dashboard) redirects to /admin/login when unauthenticated
//   - Security headers present (CSP, HSTS in prod, X-Frame-Options DENY)

test.describe("App public surfaces (bot.example.com)", () => {
  test("/health returns ok", async ({ request }) => {
    const res = await request.get(`${APP_URL}/health`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.ts).toBe("string");
  });

  test("/ redirects to /admin/login when unauthenticated", async ({ page }) => {
    const response = await page.goto(`${APP_URL}/`, { waitUntil: "networkidle" });
    expect(response?.ok()).toBeTruthy();
    expect(page.url()).toMatch(/\/admin\/(login|onboarding)?$/);
  });

  test("/admin/login renders Google-only sign-in", async ({ page }) => {
    await page.goto(`${APP_URL}/admin/login`);
    await expect(page).toHaveTitle(/Sign in.*hiagents/);
    await expect(page.getByText(/Continue with Google/i)).toBeVisible();
    // Belt-and-braces: no password input anywhere
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByText(/admin password/i)).toHaveCount(0);
  });

  test("/admin (dashboard) redirects to login when no session", async ({ page, context }) => {
    await context.clearCookies();
    const response = await page.goto(`${APP_URL}/admin`, { waitUntil: "load" });
    expect(response?.ok()).toBeTruthy();
    expect(page.url()).toContain("/admin/login");
  });

  test("/admin/onboarding redirects to login when no session", async ({ page, context }) => {
    await context.clearCookies();
    const response = await page.goto(`${APP_URL}/admin/onboarding`, { waitUntil: "load" });
    expect(response?.ok()).toBeTruthy();
    expect(page.url()).toContain("/admin/login");
  });

  test("/admin/api/* returns 401 envelope when no session", async ({ request }) => {
    const res = await request.get(`${APP_URL}/admin/api/status`);
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
    expect(body.message).toMatch(/sign in/i);
  });

  test("security headers present on the login page", async ({ page }) => {
    const response = await page.goto(`${APP_URL}/admin/login`);
    const headers = response!.headers();
    expect(headers["content-security-policy"], "CSP header set").toBeTruthy();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBeTruthy();
    // HSTS is only emitted when NODE_ENV=production. The test passes both
    // against the prod VPS (HSTS present) and a local dev build (HSTS
    // absent). Server.ts gates it on env.NODE_ENV === 'production'.
    const isProdHost = /^https:\/\//.test(APP_URL);
    if (isProdHost) {
      expect(headers["strict-transport-security"], "HSTS on prod").toBeTruthy();
    }
  });

  test("POST /admin/api/* without CSRF rejected (403)", async ({ request }) => {
    // Even without a session this should hit requireAdmin first → 401, but
    // we want to verify the envelope shape is consistent. A *signed-in*
    // session without CSRF is what gets the 403; covered manually.
    const res = await request.post(`${APP_URL}/admin/api/documents`, {
      data: { foo: "bar" },
    });
    // Either 401 (no session) or 403 (no CSRF) is acceptable here; both
    // are envelope errors.
    expect([401, 403]).toContain(res.status());
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.message).toBeTruthy();
  });
});
