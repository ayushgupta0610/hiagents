// Renders tmp/sample-kb/aiagencycorp-services.html → .pdf using the Playwright
// that's already installed for the QA suite. Lives under qa/ so Node can
// resolve `playwright` from qa/node_modules.
//
// Run from anywhere:
//   node qa/scripts/build-sample-kb.mjs

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const kbDir = resolve(here, "../../tmp/sample-kb");
const inputUrl = "file://" + resolve(kbDir, "aiagencycorp-services.html");
const outputPath = resolve(kbDir, "aiagencycorp-services.pdf");

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(inputUrl, { waitUntil: "networkidle" });
await page.pdf({
  path: outputPath,
  format: "Letter",
  margin: { top: "0.75in", bottom: "0.75in", left: "0.85in", right: "0.85in" },
  printBackground: true,
  preferCSSPageSize: true,
});
await browser.close();
console.log("Generated:", outputPath);
