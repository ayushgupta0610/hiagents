// Auth-gated dashboard QA. Uses the same throwaway-tenant + minted-cookie
// pattern as 05-onboarding-auth.spec.ts. Exercises the user-facing parts
// of the dashboard that don't need a populated mailbox / KB / activity:
//   - Overview tab renders (KPI cards, Gmail connection card)
//   - Activity tab loads, shows "no emails yet" empty state
//   - Knowledge base tab loads, shows empty drop zone
//   - Settings tab loads, persona form is editable, save round-trips
//   - The new toast system fires green on success (not the red banner
//     bug)
//   - Sidebar pause toggle works
//
// Skipped unless HIAGENTS_QA_AUTH=1 + a local server is reachable at
// HIAGENTS_APP_URL (default http://localhost:3000). Cleans up its
// throwaway tenant in afterAll.

import { test, expect } from "@playwright/test";
import { createHmac, randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { APP_URL } from "../playwright.config";

const SHOULD_RUN = process.env.HIAGENTS_QA_AUTH === "1";
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env.local") });

const COOKIE_NAME = "hiagents_admin";
const STAMP = Date.now();
const TEST_EMAIL = `qa-dashboard-${STAMP}@hiagents-qa.example.com`;
const TEST_TENANT_NAME = `qa-dashboard-${STAMP}`;

function mintSessionCookie(email: string, tenantId: string, secret: string): string {
  const ts = String(Date.now());
  const encode = (s: string) => Buffer.from(s, "utf-8").toString("base64url");
  const payload = `${ts}.${encode(email)}.${encode(tenantId)}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function mintCsrfCookie(secret: string): string {
  const nonce = Date.now().toString(36) + randomBytes(4).toString("base64url");
  const sig = createHmac("sha256", secret).update(`csrf:${nonce}`).digest("hex");
  return `${nonce}.${sig}`;
}

let supabase: SupabaseClient | null = null;
let testTenantId: string | null = null;
let sessionCookie = "";
let csrfCookie = "";

test.describe("Dashboard end-to-end (auth-gated)", () => {
  test.skip(!SHOULD_RUN, "Set HIAGENTS_QA_AUTH=1 to run + ensure local server is up");

  test.beforeAll(async () => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const sessionSecret = process.env.SESSION_SECRET;
    if (!url || !key || !sessionSecret) throw new Error("env not set");
    supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Provision a tenant with onboarding ALREADY complete so /admin
    // doesn't redirect us to /admin/onboarding.
    const { data: tenant, error: tErr } = await supabase
      .from("tenants")
      .insert({
        name: TEST_TENANT_NAME,
        slug: TEST_TENANT_NAME,
        created_by_email: TEST_EMAIL,
        onboarding_completed_at: new Date().toISOString(),
        settings: {
          persona: {
            signature: "— QA tester",
            tone: "professional, warm, concise",
            companyDescription: "QA test workspace",
            configured: true,
          },
          classifier: { model: "openai/gpt-4o-mini", prompt: null },
          reply: { model: "deepseek/deepseek-v4-flash" },
          retrieval: { similarityThreshold: 0.3, topK: 5 },
          polling: { intervalSeconds: 60, autoSend: true, paused: false },
          limits: {
            dailyEmailCap: 200,
            perSenderDailyReplyCap: 5,
            totalChunkCap: 5000,
            maxPdfBytes: 25 * 1024 * 1024,
            dailySpendCapUsd: 5,
          },
        },
      })
      .select()
      .single();
    if (tErr || !tenant) throw new Error(`tenant insert: ${tErr?.message}`);
    testTenantId = (tenant as { id: string }).id;
    await supabase.from("memberships").insert({
      tenant_id: testTenantId,
      email: TEST_EMAIL,
      role: "owner",
    });
    await supabase.from("oauth_tokens").insert({
      tenant_id: testTenantId,
      email: TEST_EMAIL,
      access_token: "v1:AAAAAAAA",
      refresh_token: "v1:AAAAAAAA",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      scope: "openid email profile",
    });

    sessionCookie = mintSessionCookie(TEST_EMAIL, testTenantId, sessionSecret);
    csrfCookie = mintCsrfCookie(sessionSecret);
  });

  test.afterAll(async () => {
    if (!supabase || !testTenantId) return;
    await supabase.from("memberships").delete().eq("tenant_id", testTenantId);
    await supabase.from("oauth_tokens").delete().eq("tenant_id", testTenantId);
    await supabase.from("tenants").delete().eq("id", testTenantId);
  });

  // Shared setup: every test arrives at /admin (post-onboarding dashboard)
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      {
        name: COOKIE_NAME,
        value: sessionCookie,
        url: APP_URL,
        httpOnly: true,
        sameSite: "Lax",
      },
      {
        name: "hiagents_csrf",
        value: csrfCookie,
        url: APP_URL,
        httpOnly: false,
        sameSite: "Lax",
      },
    ]);
  });

  test("dashboard loads, no console errors, Overview KPIs visible", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

    await page.goto(`${APP_URL}/admin`, { waitUntil: "networkidle" });

    // Sidebar shows the tenant admin email
    await expect(page.locator("#admin-email")).toContainText(TEST_EMAIL);
    // KPI cards present
    await expect(page.locator("#kpi-documents")).toBeVisible();
    await expect(page.locator("#kpi-sent")).toBeVisible();
    await expect(page.locator("#kpi-skipped")).toBeVisible();
    await expect(page.locator("#kpi-last")).toBeVisible();
    // Gmail connection card on Overview shows our fake mailbox email
    await expect(page.locator("#gmail-status")).toContainText(TEST_EMAIL);

    expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
  });

  test("Activity tab loads + shows empty-state for fresh tenant", async ({ page }) => {
    await page.goto(`${APP_URL}/admin#activity`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#view-activity.active")).toBeVisible();
    // No emails processed yet → empty-state copy
    await expect(page.getByText(/No emails processed yet/i)).toBeVisible();
  });

  test("KB tab loads + shows empty drop zone", async ({ page }) => {
    await page.goto(`${APP_URL}/admin#kb`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#view-kb.active")).toBeVisible();
    await expect(page.locator("#drop")).toBeVisible();
    await expect(page.getByText(/No documents yet/i)).toBeVisible();
  });

  test("Settings: persona form is editable + save shows GREEN toast (not red)", async ({ page }) => {
    await page.goto(`${APP_URL}/admin#settings`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#view-settings.active")).toBeVisible();

    // Persona fields prefilled with what we provisioned
    await expect(page.locator("#set-tone")).toHaveValue("professional, warm, concise");
    await expect(page.locator("#set-signature")).toHaveValue("— QA tester");
    await expect(page.locator("#set-company")).toHaveValue("QA test workspace");

    // Change tone and save — assert a GREEN success toast (not the old
    // red error banner regression that triggered this whole toast redesign).
    await page.locator("#set-tone").fill("friendly, casual, helpful");
    await page.locator("#save-persona").click();

    const toast = page.locator("#toast-stack .toast").first();
    await expect(toast).toBeVisible({ timeout: 5000 });
    // The new toast system tags variant via class — success = green border
    await expect(toast).toHaveClass(/toast-success/);
    await expect(toast).toContainText(/Persona saved/i);
  });

  test("Settings: AI usage card renders (zero-state)", async ({ page }) => {
    await page.goto(`${APP_URL}/admin#settings`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#usage-summary")).toContainText(/No usage yet|0\./);
  });

  test("Settings: Connected account card shows the unified post-OptionA UI", async ({ page }) => {
    await page.goto(`${APP_URL}/admin#settings`);
    await page.waitForLoadState("networkidle");
    // Connected account card present (post-Option-A merged card)
    await expect(page.getByRole("heading", { name: /Connected account/i })).toBeVisible();
    await expect(page.locator("#connected-account-row")).toContainText(TEST_EMAIL);
    // "Use a different Gmail" escape hatch link
    await expect(page.getByRole("link", { name: /Use a different Gmail/i })).toBeVisible();
  });

  test("Sidebar Pause button: dialog → flip → resume", async ({ page }) => {
    await page.goto(`${APP_URL}/admin`);
    await page.waitForLoadState("networkidle");

    // Initial state: not paused
    await expect(page.locator("#paused-banner")).toBeHidden();
    await expect(page.locator("#pause-btn-label")).toContainText(/Pause bot/i);

    // Click → modal confirm
    await page.locator("#pause-btn").click();
    const modal = page.locator(".modal-overlay");
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: /Pause bot/i }).click();

    // Now paused: banner + button label flips
    await expect(page.locator("#paused-banner.show")).toBeVisible();
    await expect(page.locator("#pause-btn-label")).toContainText(/Resume bot/i);

    // Resume via the banner CTA
    await page.locator("#resume-from-banner").click();
    await expect(page.locator("#paused-banner")).not.toHaveClass(/show/);
    await expect(page.locator("#pause-btn-label")).toContainText(/Pause bot/i);
  });
});
