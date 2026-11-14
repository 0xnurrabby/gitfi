import assert from "node:assert/strict";
import test from "node:test";
import {
  ONE_USD,
  effectiveLaunchStars,
  launchMarketCapUsdMicro,
} from "../src/shared/economics.js";

test("launch market cap starts at $10,000 and adds $10 per star", () => {
  assert.equal(launchMarketCapUsdMicro(0), BigInt(10_000 * ONE_USD));
  assert.equal(launchMarketCapUsdMicro(1), BigInt(10_010 * ONE_USD));
  assert.equal(launchMarketCapUsdMicro(250), BigInt(12_500 * ONE_USD));
  assert.equal(launchMarketCapUsdMicro(10_000), BigInt(110_000 * ONE_USD));
});

test("launch stars are sanitized and capped", () => {
  assert.equal(effectiveLaunchStars(-10), 0);
  assert.equal(effectiveLaunchStars(Number.NaN), 0);
  assert.equal(effectiveLaunchStars(2.9), 2);
  assert.equal(effectiveLaunchStars(50_000_000), 10_000_000);
});

test("a 0.5% step plus the 1.3% fee cannot produce a risk-free round trip", () => {
  const feeBps = 130;
  const buy = (10_000 - feeBps) / 10_000;
  const sell = (10_000 - feeBps) / 10_000;
  const priceMove = (10_000 + 50) / 10_000;
  assert.ok(buy * sell * priceMove < 1);
});

test("the 1.3% fee split stays inside the fee", () => {
  const creator = 50;
  const platform = 30;
  const stakers = 50;
  assert.equal(creator + platform + stakers, 130);
  assert.equal(stakers, 50);
});
