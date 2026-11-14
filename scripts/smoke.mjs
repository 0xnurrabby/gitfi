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
await page.screenshot({ path: path.join(out, "home-public.png"), fullPage: true });

await page.getByRole("button", { name: /connect near/i }).first().click();
await page.waitForTimeout(400);
const buttons = await page.locator(".auth-modal-compact .btn").allInnerTexts();
console.log("auth buttons:", buttons.join(" | "));
if (!buttons.length) throw new Error("Auth modal has no connect button");
if (buttons.some((label) => /sandbox/i.test(label))) {
  throw new Error("Sandbox login option is still present");
}
await page.screenshot({ path: path.join(out, "auth-modal.png") });

await page.getByRole("button", { name: /^Connect NEAR wallet$/ }).click();
await page.waitForTimeout(6000);
const picker = await page.locator("body").innerText();
const expected = ["Select wallet", "Meteor Wallet", "Intear Wallet", "Nightly Wallet", "NEAR CLI"];
for (const label of expected) {
  if (!picker.includes(label)) throw new Error(`wallet picker missing ${label}`);
}
console.log("wallet picker:", expected.join(", "));
await page.screenshot({ path: path.join(out, "wallet-picker.png") });

await page.goto(`${BASE}/proof`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);
const nearLive = await page.getByText("NEAR TESTNET").count();
console.log("proof testnet cards:", nearLive);

const mobile = await context.newPage();
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.goto(BASE, { waitUntil: "networkidle" });
const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth);
console.log("mobile overflow:", `${overflow}/390`);
await mobile.screenshot({ path: path.join(out, "home-mobile.png"), fullPage: true });

console.log("errors:", errors.length ? errors.slice(0, 5).join(" || ") : "none");
await browser.close();
if (errors.length) process.exitCode = 1;
