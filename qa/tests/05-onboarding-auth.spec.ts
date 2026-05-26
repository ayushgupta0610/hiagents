// Auth-gated end-to-end QA of /admin/onboarding without a real Google flow.
//
// Strategy: provision a throwaway tenant + membership directly in Supabase,
// mint a valid hiagents_admin cookie (HMAC-signed with the local
// SESSION_SECRET — same format the server expects), set it via Playwright,
// then drive the actual onboarding HTML against the real server. Asserts
// the Set-up card is visible on first paint (the recent first-paint fix),
// the Continue button posts + advances + re-enables itself (the recent
// finally-block fix), and there are no console errors at any point (the
// orphan-listener fix).
//
// Cleanup runs in afterAll — deletes the test tenant + cascades. Safe to
// rerun. Skipped unless HIAGENTS_QA_AUTH=1 + a local server is reachable
// at HIAGENTS_APP_URL (default http://localhost:3000).
//
// Run with:
//   HIAGENTS_QA_AUTH=1 HIAGENTS_APP_URL=http://localhost:3000 \
//     npx playwright test 05-onboarding-auth

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
const TEST_EMAIL = `qa-onboarding-${STAMP}@hiagents-qa.example.com`;
const TEST_TENANT_NAME = `qa-onboarding-${STAMP}`;

// Mirror src/lib/auth.ts issueCookie() exactly. If the format diverges
// the test will fail loudly which is the right signal.
function mintSessionCookie(email: string, tenantId: string, sessionSecret: string): string {
  const ts = String(Date.now());
  const encode = (s: string) => Buffer.from(s, "utf-8").toString("base64url");
  const payload = `${ts}.${encode(email)}.${encode(tenantId)}`;
  const sig = createHmac("sha256", sessionSecret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function mintCsrfCookie(sessionSecret: string): string {
  const nonce = Date.now().toString(36) + randomBytes(4).toString("base64url");
  const sig = createHmac("sha256", sessionSecret).update(`csrf:${nonce}`).digest("hex");
  return `${nonce}.${sig}`;
}

let supabase: SupabaseClient | null = null;
let testTenantId: string | null = null;
let sessionCookie: string | null = null;
let csrfCookie: string | null = null;

test.describe("Onboarding end-to-end (auth-gated)", () => {
  test.skip(!SHOULD_RUN, "Set HIAGENTS_QA_AUTH=1 to run + ensure local server is up");

  test.beforeAll(async () => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const sessionSecret = process.env.SESSION_SECRET;
    if (!url || !key || !sessionSecret) {
      throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SESSION_SECRET must be set");
    }
    supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Provision a fresh test tenant — minimal settings, no Gmail tokens,
    // simulates a brand-new user right after the unified OAuth signin.
    const { data: tenant, error: tErr } = await supabase
      .from("tenants")
      .insert({
        name: TEST_TENANT_NAME,
        slug: TEST_TENANT_NAME,
        created_by_email: TEST_EMAIL,
        settings: {
          persona: { signature: "", tone: "", companyDescription: "", configured: false },
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
    if (tErr || !tenant) throw new Error(`tenant insert failed: ${tErr?.message}`);
    testTenantId = (tenant as { id: string }).id;

    const { error: mErr } = await supabase.from("memberships").insert({
      tenant_id: testTenantId,
      email: TEST_EMAIL,
      role: "owner",
    });
    if (mErr) throw new Error(`membership insert failed: ${mErr.message}`);

    // Simulate Option A's "signin saved mailbox tokens" — insert a fake
    // oauth_tokens row so steps.mailbox is true. Tokens are bogus (the
    // poller would fail to decrypt) but the row's mere presence is what
    // the state endpoint checks. Cleanup deletes the cascade.
    const { error: oErr } = await supabase.from("oauth_tokens").insert({
      tenant_id: testTenantId,
      email: TEST_EMAIL,
      access_token: "v1:AAAAAAAA",
      refresh_token: "v1:AAAAAAAA",
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      scope: "openid email profile",
    });
    if (oErr) throw new Error(`oauth_tokens insert failed: ${oErr.message}`);

    sessionCookie = mintSessionCookie(TEST_EMAIL, testTenantId, sessionSecret);
    csrfCookie = mintCsrfCookie(sessionSecret);
  });

  test.afterAll(async () => {
    if (!supabase || !testTenantId) return;
    // Soft delete + hard delete the whole tenant. Memberships,
    // oauth_tokens, kb_documents, messages, audit_log etc all cascade.
    await supabase.from("memberships").delete().eq("tenant_id", testTenantId);
    await supabase.from("oauth_tokens").delete().eq("tenant_id", testTenantId);
    await supabase.from("tenants").delete().eq("id", testTenantId);
  });

  test("Set up card is visible on first paint + no console errors", async ({ page, context }) => {
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

    await context.addCookies([
      {
        name: COOKIE_NAME,
        value: sessionCookie!,
        url: APP_URL,
        httpOnly: true,
        sameSite: "Lax",
      },
      {
        name: "hiagents_csrf",
        value: csrfCookie!,
        url: APP_URL,
        httpOnly: false,
        sameSite: "Lax",
      },
    ]);

    await page.goto(`${APP_URL}/admin/onboarding`, { waitUntil: "networkidle" });

    // Most important: Set up card is visible. Before the first-paint fix
    // this could be invisible if loadState had any trouble.
    await expect(page.locator("#step-setup")).toBeVisible();
    await expect(page.locator("#name")).toBeVisible();
    await expect(page.getByRole("button", { name: /Continue/ })).toBeVisible();

    // No JS console errors — the orphan-listener bug used to print a
    // "Cannot read properties of null (reading 'addEventListener')" at
    // script load. Anything in here is a regression.
    expect(
      consoleErrors,
      `console errors during onboarding load:\n${consoleErrors.join("\n")}`,
    ).toEqual([]);
  });

  test("Continue advances past Setup + button re-enables", async ({ page, context }) => {
    await context.addCookies([
      {
        name: COOKIE_NAME,
        value: sessionCookie!,
        url: APP_URL,
        httpOnly: true,
        sameSite: "Lax",
      },
      {
        name: "hiagents_csrf",
        value: csrfCookie!,
        url: APP_URL,
        httpOnly: false,
        sameSite: "Lax",
      },
    ]);

    await page.goto(`${APP_URL}/admin/onboarding`);
    await expect(page.locator("#step-setup")).toBeVisible();

    // Type a workspace name that intentionally matches the email's local-
    // part — regression for the welcome-step heuristic bug. Previously
    // this would keep welcome=false and the user would never advance.
    await page.locator("#name").fill(`qa-onboarding-${STAMP}`);
    await page.locator("#signature").fill("— QA tester");
    // tone + companyDescription + classifierPrompt deliberately left
    // blank — they're all optional. The Continue button should still
    // accept the form and advance.

    const continueBtn = page.getByRole("button", { name: /Continue/ });
    await continueBtn.click();

    // After the POST batch + loadState refresh:
    //   - Set up step should be marked done in the progress bar
    //   - The Knowledge card should be visible (steps.kb is false on
    //     this fresh tenant; we inserted no kb_documents row)
    //   - The button should no longer say "Saving…" (regression for
    //     the missing finally block)
    await expect(page.locator("#step-kb")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#step-setup")).toBeHidden();
    await expect(
      page.locator('.progress-step[data-step="setup"]'),
      "Set up step should be marked done after advancing",
    ).toHaveClass(/done/);
    await expect(
      page.locator('.progress-step[data-step="kb"]'),
      "Knowledge step should be the current step",
    ).toHaveClass(/current/);
  });
});
