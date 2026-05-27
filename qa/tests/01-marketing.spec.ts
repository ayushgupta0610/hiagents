import { test, expect } from "@playwright/test";
import { MARKETING_URL } from "../playwright.config";

// hiagents.digital — waitlist-only marketing site.
// Smoke-tests every promise the page makes structurally:
//   - it renders without console errors
//   - hero copy + waitlist form are present and interactive
//   - sitemap.xml and robots.txt are served
//   - opengraph-image returns a real PNG
//   - JSON-LD validates as parseable schema.org

test.describe("Marketing site (hiagents.digital)", () => {
  test("hero renders, no console errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    const response = await page.goto(MARKETING_URL, { waitUntil: "networkidle" });
    expect(response?.ok(), "marketing site should respond 2xx").toBeTruthy();

    await expect(page).toHaveTitle(/Inbox.*replies to your customers/i);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      /Reply to every customer email/i,
    );
    await expect(page.getByText(/Even at 2am/i)).toBeVisible();

    // Trust badges from the hero — these strings appear in multiple places
    // on the page (FAQ answers reuse some), so scope to the first match.
    await expect(page.getByText(/Gmail-native/i).first()).toBeVisible();
    await expect(page.getByText(/AES-256-GCM/i).first()).toBeVisible();
    await expect(page.getByText(/Per-workspace spend cap/i).first()).toBeVisible();
    await expect(page.getByText(/One-click pause/i).first()).toBeVisible();

    expect(consoleErrors, "no console errors").toEqual([]);
  });

  test("waitlist form is present and accepts input", async ({ page }) => {
    await page.goto(MARKETING_URL);
    const heroEmail = page.locator('input[type="email"][name="email"]').first();
    await expect(heroEmail).toBeVisible();
    await heroEmail.fill("qa-smoke-test+do-not-respond@example.com");
    // We DO NOT submit — this is a smoke test, not a load test on /api/waitlist.
    // Submission is exercised separately in 02-marketing-form.spec.ts when
    // the operator passes HIAGENTS_QA_SUBMIT=1.
    await expect(page.getByRole("button", { name: /Join waitlist/i }).first()).toBeVisible();
  });

  test("section anchors all reachable from the page", async ({ page }) => {
    await page.goto(MARKETING_URL);
    for (const anchor of ["#how", "#flow", "#faq", "#waitlist"]) {
      const id = anchor.slice(1);
      const section = page.locator(`section#${id}`).first();
      await expect(section, `section ${anchor} present in DOM`).toHaveCount(1);
    }
  });

  test("FAQ items are expandable", async ({ page }) => {
    await page.goto(MARKETING_URL);
    const firstFaq = page.locator("section#faq details").first();
    await expect(firstFaq).toBeVisible();
    await firstFaq.click();
    // After click the details element should be open
    await expect(firstFaq).toHaveAttribute("open", "");
  });

  test("no link to app.hiagents.digital or bot.example.com (waitlist-only mode)", async ({ page }) => {
    await page.goto(MARKETING_URL);
    const html = await page.content();
    expect(html, "marketing site must not link to the app while we're waitlist-only").not.toMatch(
      /app\.hiagents\.digital|bot\.example\.com/i,
    );
  });

  test("/robots.txt served + points at sitemap", async ({ request }) => {
    const res = await request.get(`${MARKETING_URL}/robots.txt`);
    expect(res.ok()).toBeTruthy();
    const body = await res.text();
    expect(body).toContain("User-Agent: *");
    expect(body).toContain("Sitemap:");
    expect(body).toMatch(/hiagents\.digital/);
  });

  test("/sitemap.xml served + lists root + section anchors", async ({ request }) => {
    const res = await request.get(`${MARKETING_URL}/sitemap.xml`);
    expect(res.ok()).toBeTruthy();
    const body = await res.text();
    expect(body).toContain("<urlset");
    expect(body).toContain("hiagents.digital");
    for (const anchor of ["#how", "#flow", "#faq", "#waitlist"]) {
      expect(body, `sitemap mentions ${anchor}`).toContain(anchor);
    }
  });

  test("/opengraph-image returns a real PNG", async ({ request }) => {
    const res = await request.get(`${MARKETING_URL}/opengraph-image`);
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-type"]).toContain("image/png");
    const buf = await res.body();
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    expect(buf.slice(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(buf.byteLength, "OG image should be > 10KB").toBeGreaterThan(10_000);
  });

  test("JSON-LD parses + has Organization + SoftwareApplication + FAQPage", async ({ page }) => {
    await page.goto(MARKETING_URL);
    const jsonText = await page.locator('script[type="application/ld+json"]').first().textContent();
    expect(jsonText, "JSON-LD script present").toBeTruthy();
    const parsed = JSON.parse(jsonText!);
    expect(parsed["@context"]).toBe("https://schema.org");
    const types = (parsed["@graph"] as Array<{ "@type": string }>).map((g) => g["@type"]);
    expect(types).toEqual(expect.arrayContaining(["Organization", "SoftwareApplication", "FAQPage"]));
    // SoftwareApplication should NOT have offers right now (pre-launch)
    const swApp = parsed["@graph"].find(
      (g: { "@type": string }) => g["@type"] === "SoftwareApplication",
    );
    expect(swApp.offers, "SoftwareApplication has no offers while pre-launch").toBeUndefined();
  });
});
