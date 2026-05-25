import { test, expect } from "@playwright/test";
import { MARKETING_URL } from "../playwright.config";

// Opt-in: actually submit the waitlist form. Skipped by default to avoid
// dropping smoke-test rows into the production waitlist table. Run with:
//   HIAGENTS_QA_SUBMIT=1 npx playwright test 02-marketing-form
//
// Verifies the end-to-end Supabase write + Resend notify path returns
// { ok: true, notify: 'sent' | 'skipped' | 'failed' } — operator decides
// what's acceptable. 'sent' = both layers green.

const SHOULD_SUBMIT = process.env.HIAGENTS_QA_SUBMIT === "1";

test.describe("Marketing form submission (opt-in)", () => {
  test.skip(!SHOULD_SUBMIT, "Set HIAGENTS_QA_SUBMIT=1 to actually submit");

  test("waitlist submit succeeds + returns notify status", async ({ request }) => {
    // Hit the API directly — no need to click through the form for this assertion.
    const stamp = Date.now();
    const res = await request.post(`${MARKETING_URL}/api/waitlist`, {
      data: {
        email: `qa-smoke-${stamp}@example.com`,
        source: "qa-smoke",
      },
      headers: { "Content-Type": "application/json" },
    });
    expect(res.ok(), `expected 2xx, got ${res.status()}`).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(["sent", "skipped", "failed"]).toContain(body.notify);
    if (body.notify === "failed") {
      console.warn("WARNING: Resend send failed. Check Vercel logs for [notify] resend failed:");
    } else if (body.notify === "skipped") {
      console.warn("INFO: Resend skipped — RESEND_API_KEY not set on this deploy.");
    }
  });

  test("waitlist rejects invalid email with a 400 + friendly message", async ({ request }) => {
    const res = await request.post(`${MARKETING_URL}/api/waitlist`, {
      data: { email: "not-an-email", source: "qa-smoke" },
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid email/i);
  });
});
