import { defineConfig, devices } from "@playwright/test";

// QA suite config. Two project flavours:
//
//   default (headed)    — the runner the operator watches. `npm test`.
//   ci (headless)       — same suite minus the auth-gated specs, for CI.
//
// Both share the same baseURL pair (MARKETING + APP), set via env so a
// preview deploy can be QA'd by overriding HIAGENTS_MARKETING_URL +
// HIAGENTS_APP_URL.

export const MARKETING_URL =
  process.env.HIAGENTS_MARKETING_URL ?? "https://hiagents.digital";
export const APP_URL =
  process.env.HIAGENTS_APP_URL ?? "https://bot.aiagencycorp.com";

export default defineConfig({
  testDir: "./tests",
  // No parallel — easier to watch + reason about test order in headed mode.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    viewport: { width: 1280, height: 800 },
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    ignoreHTTPSErrors: false,
  },
  projects: [
    {
      name: "chromium-headed",
      use: {
        ...devices["Desktop Chrome"],
        headless: false,
        // Slow down a touch so the operator can follow what's happening.
        launchOptions: { slowMo: 200 },
      },
    },
  ],
});
