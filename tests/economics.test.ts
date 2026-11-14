import assert from "node:assert/strict";
import test from "node:test";
import {
  BPS,
  CURVE_SUPPLY_MICRO,
  FEE_BPS,
  GRADUATION_SOLD_MICRO,
  ONE_TOKEN,
  ONE_USD,
  TIERS,
  TOTAL_SUPPLY_MICRO,
  curveCostBetween,
  curveCostFromZero,
  curveLaunchPriceMicro,
  curvePriceMicro,
  feeParts,
  graduationBurnMicro,
  graduationPoolTokensMicro,
  marketCapMicro,
  maxWalletMicro,
  quoteCurveBuyFromUsd,
  quoteCurveSell,
  quoteDexBuy,
  quoteDexSell,
  targetPriceMicro,
  tokensForBudget,
  type Tier,
} from "../src/shared/economics.js";

const TIERS_UNDER_TEST: Tier[] = ["seed", "rising", "viral"];

test("curve launches at exactly (1-g)^2 of its graduation FDV", () => {
  for (const tier of TIERS_UNDER_TEST) {
    const launchPrice = curveLaunchPriceMicro(tier);
    assert.equal(launchPrice, targetPriceMicro(tier) / 25n);
    const graduationPrice = curvePriceMicro(tier, BigInt(GRADUATION_SOLD_MICRO));
    assert.equal(graduationPrice, targetPriceMicro(tier));
  }
});

test("curve cost accrues monotonically and quote is exact", () => {
  for (const tier of TIERS_UNDER_TEST) {
    const half = BigInt(GRADUATION_SOLD_MICRO / 2);
    const quarter = half / 2n;
    const costFirst = curveCostBetween(tier, 0n, quarter);
    const costSecond = curveCostBetween(tier, quarter, quarter);
    const costHalf = curveCostBetween(tier, 0n, half);
    assert.ok(costFirst > 0n);
    assert.ok(costSecond > costFirst, "later units must cost more");
    assert.ok(costHalf >= costFirst + costSecond - 2n, "cost must add up within rounding");
  }
});

test("token-budget inverse never overspends", () => {
  for (const tier of TIERS_UNDER_TEST) {
    const budget = BigInt(500 * ONE_USD);
    const tokens = tokensForBudget(tier, 0n, budget, BigInt(CURVE_SUPPLY_MICRO));
    assert.ok(tokens > 0n);
    const cost = curveCostBetween(tier, 0n, tokens);
    assert.ok(cost <= budget);
    if (tokens + 1n <= BigInt(CURVE_SUPPLY_MICRO)) {
      assert.ok(curveCostBetween(tier, 0n, tokens + 1n) > budget);
    }
  }
});

test("fee split conserves every micro-dollar", () => {
  const fee = 12_345_678n;
  const split = feeParts(fee);
  assert.equal(split.total, fee);
  assert.equal(
    split.developer + split.platformGross + (split.dividend - split.dividend),
    fee,
    "developer + gross platform fee equals total fee",
  );
  assert.equal(split.platformGross, split.platformNet + split.dividend);
  assert.equal(split.developer, (fee * 50n) / 100n);
});

test("graduation creates a DEX pool at exactly the target marginal price", () => {
  for (const tier of TIERS_UNDER_TEST) {
    const reserve = curveCostFromZero(tier, BigInt(GRADUATION_SOLD_MICRO));
    const poolTokens = graduationPoolTokensMicro();
    const burn = graduationBurnMicro();
    const migratedPrice = (reserve * 1_000_000n) / poolTokens;
    assert.equal(migratedPrice, targetPriceMicro(tier), `${tier} migration price mismatch`);
    assert.ok(burn > 0n);
    const remainingCurve = BigInt(CURVE_SUPPLY_MICRO) - BigInt(GRADUATION_SOLD_MICRO);
    assert.equal(poolTokens + burn, remainingCurve);
  }
});

test("per-wallet curves caps follow tier policy", () => {
  assert.equal(maxWalletMicro("seed"), (BigInt(TOTAL_SUPPLY_MICRO) * 1_000n) / 10_000n);
  assert.equal(maxWalletMicro("rising"), (BigInt(TOTAL_SUPPLY_MICRO) * 500n) / 10_000n);
  assert.equal(maxWalletMicro("viral"), (BigInt(TOTAL_SUPPLY_MICRO) * 250n) / 10_000n);
  for (const tier of TIERS_UNDER_TEST) {
    assert.ok(TIERS[tier].targetMarketCapMicro > 0);
  }
});

test("sell quote charges exactly 1% and never exceeds curve inventory", () => {
  const sold = BigInt(GRADUATION_SOLD_MICRO);
  const tokens = BigInt(1_000_000 * ONE_TOKEN);
  const quote = quoteCurveSell("viral", sold, tokens);
  assert.equal(quote.feeMicro, (quote.grossMicro * BigInt(FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS));
  assert.equal(quote.netMicro, quote.grossMicro - quote.feeMicro);
  assert.throws(() => quoteCurveSell("viral", sold, sold + 1n));
});

test("USD curve buys respect wallet cap and graduation boundary", () => {
  const walletCap = maxWalletMicro("viral");
  const quote = quoteCurveBuyFromUsd("viral", 0n, BigInt(10_000 * ONE_USD), 0n);
  assert.ok(quote.tokensMicro <= walletCap);
  assert.ok(quote.nextSoldMicro <= BigInt(GRADUATION_SOLD_MICRO));
  assert.equal(quote.tokensMicro, walletCap, "a 10k buy should hit the viral wallet cap");
});

test("CPMM quotes conserve fees and pool invariants", () => {
  const poolQuote = BigInt(100_000 * ONE_USD);
  const poolToken = BigInt(150_000_000 * ONE_TOKEN);
  const buy = quoteDexBuy(poolQuote, poolToken, BigInt(1_000 * ONE_USD));
  assert.ok(buy.tokensMicro > 0n);
  assert.equal(buy.tokensMicro + 0n, (poolToken * buy.netMicro) / (poolQuote + buy.netMicro));
  const sell = quoteDexSell(poolQuote, poolToken, buy.tokensMicro);
  assert.ok(sell.netMicro > 0n);
  assert.ok(sell.feeMicro > 0n);
});

test("market cap uses effective supply after burns", () => {
  const price = 100n;
  const burned = 42_000_000n * BigInt(ONE_TOKEN);
  assert.equal(
    marketCapMicro(price, burned),
    (price * (BigInt(TOTAL_SUPPLY_MICRO) - burned)) / BigInt(ONE_TOKEN),
  );
});
