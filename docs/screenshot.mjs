// One-shot script: open dockermate, wait for tiles + update-checks to settle,
// take a screenshot. Run inside an mcr.microsoft.com/playwright image with
// /work mounted at this directory.

import { chromium } from 'playwright';

const url = process.env.URL || 'http://dockermate:8080/';
const out = process.env.OUT || '/work/screenshot.png';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

console.log('navigating', url);
await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

// Wait for at least one tile to render.
await page.waitForSelector('[data-name]', { timeout: 30000 });

// The frontend kicks off update-checks one container at a time. Give it a
// generous chunk of time so most badges land before the screenshot.
await page.waitForTimeout(15000);

// Open the chat panel briefly to include it in the shot, since it's a
// signature feature.
await page.click('#chat-fab');
await page.waitForTimeout(500);

console.log('screenshot ->', out);
await page.screenshot({ path: out, fullPage: false });

await browser.close();
