
export const BPS = 10_000;
export const USD_DECIMALS = 6;
export const TOKEN_DECIMALS = 6;
export const ONE_USD = 1_000_000;
export const ONE_TOKEN = 1_000_000;
export const TOTAL_SUPPLY_TOKENS = 1_000_000_000;
export const TOTAL_SUPPLY_MICRO = TOTAL_SUPPLY_TOKENS * ONE_TOKEN;
export const CURVE_SUPPLY_BPS = 9_800;
export const CURVE_SUPPLY_MICRO =
  (TOTAL_SUPPLY_MICRO * CURVE_SUPPLY_BPS) / BPS;
export const MILESTONE_RESERVE_MICRO =
  TOTAL_SUPPLY_MICRO - CURVE_SUPPLY_MICRO;
export const GRADUATION_SOLD_BPS = 8_000;
export const GRADUATION_SOLD_MICRO =
  (CURVE_SUPPLY_MICRO * GRADUATION_SOLD_BPS) / BPS;
export const FEE_BPS = 100;
export const DEVELOPER_FEE_BPS = 50;
export const PLATFORM_FEE_BPS = 50;
export const PLATFORM_YIELD_SHARE_BPS = 4_000;
export const REFERRAL_SHARE_BPS = 1_000;

export const LAUNCH_MC_BASE_USD = 10_000;
export const LAUNCH_MC_PER_STAR_USD = 10;
export const MAX_LAUNCH_STARS = 10_000_000;

export function effectiveLaunchStars(stars: number): number {
  if (!Number.isFinite(stars)) return 0;
  return Math.max(0, Math.min(MAX_LAUNCH_STARS, Math.floor(stars)));
}

export function launchMarketCapUsdMicro(stars: number): bigint {
  const count = effectiveLaunchStars(stars);
  return BigInt(LAUNCH_MC_BASE_USD + count * LAUNCH_MC_PER_STAR_USD) * BigInt(ONE_USD);
}

export type Tier = "seed" | "rising" | "viral";

export interface TierConfig {
  tier: Tier;
  label: string;
  shortLabel: string;
  starsMax: number | null;
  targetMarketCapMicro: number;
  perWalletCapBps: number;
  countdownSeconds: number;
  vestingDays: number;
  starStep: number;
  burnPerMilestoneMicro: number;
  color: string;
}

export const TIERS: Record<Tier, TierConfig> = {
  seed: {
    tier: "seed",
    label: "Fresh / Seed",
    shortLabel: "Seed",
    starsMax: 500,
    targetMarketCapMicro: 100_000 * ONE_USD,
    perWalletCapBps: 1_000,
    countdownSeconds: 0,
    vestingDays: 7,
    starStep: 50,
    burnPerMilestoneMicro: 100_000 * ONE_TOKEN,
    color: "lime",
  },
  rising: {
    tier: "rising",
    label: "Rising",
    shortLabel: "Rising",
    starsMax: 10_000,
    targetMarketCapMicro: 500_000 * ONE_USD,
    perWalletCapBps: 500,
    countdownSeconds: 180,
    vestingDays: 14,
    starStep: 250,
    burnPerMilestoneMicro: 500_000 * ONE_TOKEN,
    color: "amber",
  },
  viral: {
    tier: "viral",
    label: "Viral / Blue-chip",
    shortLabel: "Viral",
    starsMax: null,
    targetMarketCapMicro: 2_000_000 * ONE_USD,
    perWalletCapBps: 250,
    countdownSeconds: 600,
    vestingDays: 30,
    starStep: 1_000,
    burnPerMilestoneMicro: 1_000_000 * ONE_TOKEN,
    color: "copper",
  },
};

export function tierForStars(stars: number): Tier {
  if (stars < 500) return "seed";
  if (stars < 10_000) return "rising";
  return "viral";
}

export function targetPriceMicro(tier: Tier): bigint {
  return BigInt(TIERS[tier].targetMarketCapMicro) / BigInt(TOTAL_SUPPLY_TOKENS);
}

export function curveK(tier: Tier): bigint {
  const remainingAtGrad =
    (BigInt(CURVE_SUPPLY_MICRO) * BigInt(BPS - GRADUATION_SOLD_BPS)) / BigInt(BPS);
  return targetPriceMicro(tier) * remainingAtGrad * remainingAtGrad;
}

export function curveLaunchPriceMicro(tier: Tier): bigint {
  return targetPriceMicro(tier) * BigInt(BPS - GRADUATION_SOLD_BPS) ** 2n / BigInt(BPS) ** 2n;
}

export function curvePriceMicro(tier: Tier, soldMicro: bigint): bigint {
  const remaining = BigInt(CURVE_SUPPLY_MICRO) - soldMicro;
  if (remaining <= 0n) return 0n;
  const k = curveK(tier);
  return k / (remaining * remaining);
}

export function curveCostBetween(
  tier: Tier,
  soldMicro: bigint,
  tokenMicro: bigint,
): bigint {
  if (tokenMicro <= 0n) return 0n;
  const supply = BigInt(CURVE_SUPPLY_MICRO);
  if (soldMicro < 0n || tokenMicro <= 0n) return 0n;
  if (soldMicro + tokenMicro >= supply) {
    throw new Error("Curve cannot quote the entire remaining inventory");
  }
  const l1 = supply - soldMicro;
  const l2 = supply - soldMicro - tokenMicro;
  const numerator = curveK(tier) * tokenMicro;
  const denominator = l1 * l2 * 1_000_000n;
  return (numerator + denominator - 1n) / denominator;
}

export function curveCostFromZero(tier: Tier, soldMicro: bigint): bigint {
  return curveCostBetween(tier, 0n, soldMicro);
}

export function graduationMarketCapMicro(tier: Tier): bigint {
  return curvePriceMicro(tier, BigInt(GRADUATION_SOLD_MICRO)) * BigInt(TOTAL_SUPPLY_TOKENS);
}

export function marketCapMicro(
  priceMicro: bigint,
  burnedMicro = 0n,
): bigint {
  const supply = BigInt(TOTAL_SUPPLY_MICRO) - burnedMicro;
  return (priceMicro * supply) / BigInt(ONE_TOKEN);
}

export function maxWalletMicro(tier: Tier): bigint {
  return (BigInt(TOTAL_SUPPLY_MICRO) * BigInt(TIERS[tier].perWalletCapBps)) / BigInt(BPS);
}

export function tokensForBudget(
  tier: Tier,
  soldMicro: bigint,
  budgetMicro: bigint,
  maxOutMicro: bigint,
): bigint {
  const supply = BigInt(CURVE_SUPPLY_MICRO);
  let low = 0n;
  let high = supply - soldMicro;
  if (maxOutMicro < high) high = maxOutMicro;
  if (high < 0n) high = 0n;
  const finiteMax = supply - soldMicro - 1n;
  if (finiteMax <= 0n) return 0n;
  if (high > finiteMax) high = finiteMax;
  if (high > 0n && curveCostBetween(tier, soldMicro, high) <= budgetMicro) return high;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (curveCostBetween(tier, soldMicro, mid) <= budgetMicro) {
      low = mid;
    } else {
      high = mid - 1n;
    }
  }
  return low;
}

export function feeParts(feeMicro: bigint, yieldShareBps = PLATFORM_YIELD_SHARE_BPS) {
  const developer = (feeMicro * BigInt(DEVELOPER_FEE_BPS)) / BigInt(FEE_BPS);
  const platformGross = feeMicro - developer;
  const dividend = (platformGross * BigInt(yieldShareBps)) / BigInt(BPS);
  return {
    developer,
    platformGross,
    dividend,
    platformNet: platformGross - dividend,
    total: feeMicro,
  };
}

export function ceilBps(amount: bigint, bps: number): bigint {
  const b = BigInt(bps);
  return (amount * b + BigInt(BPS) - 1n) / BigInt(BPS);
}

export function floorBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / BigInt(BPS);
}

export function quoteCurveBuyFromUsd(
  tier: Tier,
  soldMicro: bigint,
  totalSpendMicro: bigint,
  walletHoldingMicro: bigint,
): {
  tokensMicro: bigint;
  baseCostMicro: bigint;
  feeMicro: bigint;
  nextSoldMicro: bigint;
} {
  const fee = floorBps(totalSpendMicro, FEE_BPS);
  const net = totalSpendMicro - fee;
  const maxWallet = maxWalletMicro(tier) - walletHoldingMicro;
  const untilGrad = BigInt(GRADUATION_SOLD_MICRO) - soldMicro;
  const maxOut = minBig(maxWallet, untilGrad);
  let tokens = tokensForBudget(tier, soldMicro, net, maxOut);
  let baseCost = curveCostBetween(tier, soldMicro, tokens);
  while (tokens > 0n && baseCost > net) {
    tokens -= 1n;
    baseCost = curveCostBetween(tier, soldMicro, tokens);
  }
  if (tokens === 0n) {
    return {
      tokensMicro: 0n,
      baseCostMicro: 0n,
      feeMicro: 0n,
      nextSoldMicro: soldMicro,
    };
  }
  return {
    tokensMicro: tokens,
    baseCostMicro: baseCost,
    feeMicro: fee,
    nextSoldMicro: soldMicro + tokens,
  };
}

export function quoteCurveSell(
  tier: Tier,
  soldMicro: bigint,
  tokenMicro: bigint,
): {
  grossMicro: bigint;
  feeMicro: bigint;
  netMicro: bigint;
  nextSoldMicro: bigint;
} {
  if (tokenMicro <= 0n || tokenMicro > soldMicro) throw new Error("Invalid sell size");
  const gross = curveCostBetween(tier, soldMicro - tokenMicro, tokenMicro);
  const fee = ceilBps(gross, FEE_BPS);
  return {
    grossMicro: gross,
    feeMicro: fee,
    netMicro: gross - fee,
    nextSoldMicro: soldMicro - tokenMicro,
  };
}

export type CurvePhase = "bonding" | "graduated";

export interface CurveState {
  tier: Tier;
  phase: CurvePhase;
  soldMicro: bigint;
  reserveMicro: bigint;
  poolQuoteMicro: bigint;
  poolTokenMicro: bigint;
}

export function currentPriceMicro(state: CurveState): bigint {
  if (state.phase === "graduated") {
    if (state.poolTokenMicro <= 0n) return 0n;
    return (state.poolQuoteMicro * BigInt(ONE_TOKEN)) / state.poolTokenMicro;
  }
  return curvePriceMicro(state.tier, state.soldMicro);
}

export function progressBps(state: CurveState): number {
  if (state.phase === "graduated") return BPS;
  return Number((state.soldMicro * BigInt(BPS)) / BigInt(GRADUATION_SOLD_MICRO));
}

export function quoteDexBuy(
  poolQuoteMicro: bigint,
  poolTokenMicro: bigint,
  totalSpendMicro: bigint,
): { tokensMicro: bigint; feeMicro: bigint; netMicro: bigint } {
  const fee = floorBps(totalSpendMicro, FEE_BPS);
  const net = totalSpendMicro - fee;
  const tokens = (poolTokenMicro * net) / (poolQuoteMicro + net);
  return { tokensMicro: tokens, feeMicro: fee, netMicro: net };
}

export function quoteDexSell(
  poolQuoteMicro: bigint,
  poolTokenMicro: bigint,
  tokenMicro: bigint,
): { grossMicro: bigint; feeMicro: bigint; netMicro: bigint } {
  const gross = (poolQuoteMicro * tokenMicro) / (poolTokenMicro + tokenMicro);
  const fee = ceilBps(gross, FEE_BPS);
  return { grossMicro: gross, feeMicro: fee, netMicro: gross - fee };
}

export function graduationPoolTokensMicro(): bigint {
  const remaining = BigInt(CURVE_SUPPLY_MICRO) - BigInt(GRADUATION_SOLD_MICRO);
  return (remaining * BigInt(GRADUATION_SOLD_BPS)) / BigInt(BPS);
}

export function graduationBurnMicro(): bigint {
  const remaining = BigInt(CURVE_SUPPLY_MICRO) - BigInt(GRADUATION_SOLD_MICRO);
  return remaining - graduationPoolTokensMicro();
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function safeNum(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError("Integer exceeds JS safe range");
  }
  return Number(value);
}

export function toBigInt(value: number | string | bigint | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  try {
    return BigInt(typeof value === "number" ? Math.trunc(value) : value);
  } catch {
    return 0n;
  }
}
