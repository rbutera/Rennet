import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto("http://localhost:3947/?scenario=returned", { waitUntil: "load" });
await page.waitForTimeout(2500);
await page
  .locator("button", { hasText: "Back to the Boards" })
  .first()
  .click()
  .catch(() => {});
await page.waitForTimeout(600);
await page.locator("button", { hasText: "Continue" }).first().click();
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/pr-page2.png" });
await browser.close();
