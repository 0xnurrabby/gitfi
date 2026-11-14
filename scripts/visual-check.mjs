import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.GITFI_URL ?? "http://localhost:8787";
const out = path.resolve("data");
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
});
const errors = [];
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  colorScheme: "light",
});
const page = await context.newPage();
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(`PAGEERROR ${error.message}`));

await page.goto(BASE, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.setItem("gitfi.theme", "light"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(out, "home-light.png"), fullPage: true });

await page.goto(`${BASE}/explore`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, "explore-light.png"), fullPage: true });

await page.goto(`${BASE}/token/bun-bun`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(out, "token-light.png"), fullPage: true });

await page.goto(`${BASE}/launch`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, "launch-light.png"), fullPage: true });

await page.goto(`${BASE}/leaderboard`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, "leaderboard-light.png"), fullPage: true });

await page.goto(`${BASE}/proof`, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, "proof-light.png"), fullPage: true });

await page.evaluate(() => localStorage.setItem("gitfi.theme", "dark"));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.goto(BASE, { waitUntil: "networkidle" });
await page.screenshot({ path: path.join(out, "home-dark.png"), fullPage: true });

console.log("errors:", errors.length ? errors : "none");
await browser.close();
