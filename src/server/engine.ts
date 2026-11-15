import crypto from "node:crypto";
import { db, nowIso, withTransaction } from "./db.js";
import type { UserRow } from "./auth.js";
import { randomId } from "./auth.js";
import { appendReceipt } from "./ledger.js";
import { queueReceiptAnchor } from "./chain.js";
import {
  BPS,
  DEVELOPER_FEE_BPS,
  FEE_BPS,
  GRADUATION_SOLD_MICRO,
  PLATFORM_YIELD_SHARE_BPS,
  REFERRAL_SHARE_BPS,
  TIERS,
  curveCostBetween,
  curveCostFromZero,
  curvePriceMicro,
  feeParts,
  graduationBurnMicro,
  graduationPoolTokensMicro,
  maxWalletMicro,
  quoteCurveSell,
  quoteDexBuy,
  quoteDexSell,
  tokensForBudget,
  toBigInt,
} from "../shared/economics.js";
import type { QuoteResponse, Trade } from "../shared/types.js";
import {
  getTokenById,
  getUserByAddress,
  pendingStakeDividends,
  type TokenRow,
} from "./tokens.js";
import { isKingToken } from "./king.js";
import { isPaused } from "./db.js";

export class TradeError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(message: string, status = 400, code = "TRADE_ERROR", details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface TradeInput {
  side: "buy" | "sell";
  amountMicro: number;
  input: "usd" | "token";
  minOutMicro?: number;
}

export interface FeeSplit {
  developer: bigint;
  platformGross: bigint;
  dividend: bigint;
  platformNet: bigint;
  referral: bigint;
}

interface QuoteInternal {
  public: QuoteResponse;
  feeParts: FeeSplit;
  tokens: bigint;
  base: bigint;
  fee: bigint;
  total: bigint;
  priceBefore: bigint;
  priceAfter: bigint;
  phase: "bonding" | "graduated";
  willGraduate: boolean;
  king: boolean;
}

function activeVesting(holding?: {
  vesting_locked_micro: number;
  vesting_until: string | null;
} | null): number {
  if (!holding?.vesting_until) return 0;
  return new Date(holding.vesting_until).getTime() > Date.now()
    ? holding.vesting_locked_micro
    : 0;
}

export function availableTokens(
  userId: string,
  tokenId: string,
  holding?: { amount_micro: number } | null,
): bigint {
  const h =
    holding ??
    (db
      .prepare("SELECT amount_micro FROM holdings WHERE user_id = ? AND token_id = ?")
      .get(userId, tokenId) as { amount_micro: number } | undefined);
  const stake = db
    .prepare("SELECT amount_micro FROM stakes WHERE user_id = ? AND token_id = ?")
    .get(userId, tokenId) as { amount_micro: number } | undefined;
  const full = db
    .prepare(
      "SELECT vesting_locked_micro, vesting_until FROM holdings WHERE user_id = ? AND token_id = ?",
    )
    .get(userId, tokenId) as
    | { vesting_locked_micro: number; vesting_until: string | null }
    | undefined;
  const lockedVesting = activeVesting(full);
  return (
    toBigInt(h?.amount_micro ?? 0) -
    toBigInt(stake?.amount_micro ?? 0) -
    toBigInt(lockedVesting)
  );
}

function feeFor(feeBps: number, base: bigint): bigint {
  return (base * BigInt(feeBps) + BigInt(BPS) - 1n) / BigInt(BPS);
}

function splitFee(fee: bigint, king: boolean, yieldShareBps: number): FeeSplit {
  if (king) {
    return {
      developer: fee,
      platformGross: 0n,
      dividend: 0n,
      platformNet: 0n,
      referral: 0n,
    };
  }
  const parts = feeParts(fee, yieldShareBps);
  return { ...parts, referral: 0n };
}

function publicQuote(input: {
  side: "buy" | "sell";
  phase: "bonding" | "graduated";
  tokens: bigint;
  base: bigint;
  fee: bigint;
  total: bigint;
  priceBefore: bigint;
  priceAfter: bigint;
  token: TokenRow;
  errors: string[];
  walletCapTokensMicro: number | null;
  availableMicro: number | null;
  walletCapReached: boolean;
  willGraduate: boolean;
  split: FeeSplit;
}): QuoteResponse {
  const impact =
    input.priceBefore > 0n
      ? Number(((input.priceAfter - input.priceBefore) * 10_000n) / input.priceBefore)
      : 0;
  const nextSold =
    input.phase === "bonding"
      ? input.token.sold_micro + Number(input.tokens)
      : input.token.sold_micro;
  const progress =
    input.phase === "graduated"
      ? 10_000
      : Math.max(
          0,
          Math.min(10_000, Math.floor((nextSold * 10_000) / GRADUATION_SOLD_MICRO)),
        );
  return {
    side: input.side,
    phase: input.phase === "bonding" ? "curve" : "dex",
    tokensMicro: Number(input.tokens),
    baseCostMicro: Number(input.base),
    feeMicro: Number(input.fee),
    totalMicro: Number(input.total),
    priceBeforeMicro: Number(input.priceBefore),
    priceAfterMicro: Number(input.priceAfter),
    priceImpactBps: impact,
    progressBps: progress,
    walletCapTokensMicro: input.walletCapTokensMicro,
    availableMicro: input.availableMicro,
    walletCapReached: input.walletCapReached,
    willGraduate: input.willGraduate,
    errors: input.errors,
    feeSplit: {
      developerMicro: Number(input.split.developer),
      platformGrossMicro: Number(input.split.platformGross),
      dividendMicro: Number(input.split.dividend),
      platformNetMicro: Number(input.split.platformNet),
    },
  };
}

export function quoteTrade(
  tokenId: string,
  user: UserRow | null,
  input: TradeInput,
): QuoteResponse {
  const token = getTokenById(tokenId);
  if (!token) throw new TradeError("Token not found.", 404, "TOKEN_NOT_FOUND");
  const quote = buildQuote(token, user, input);
  return quote.public;
}

export function buildQuote(token: TokenRow, user: UserRow | null, input: TradeInput): QuoteInternal {
  if (isPaused()) throw new TradeError("Trading is temporarily paused by the circuit breaker.", 503, "PAUSED");
  if (token.status === "prelaunch") {
    throw new TradeError("This launch is still in its countdown.", 409, "PRELAUNCH");
  }
  if (token.status !== "bonding" && token.status !== "graduated") {
    throw new TradeError("This market is not currently tradeable.", 409, "NOT_TRADEABLE");
  }
  if (token.launch_at && new Date(token.launch_at).getTime() > Date.now()) {
    throw new TradeError("This launch is still in its countdown.", 409, "PRELAUNCH");
  }
  if (!Number.isSafeInteger(input.amountMicro) || input.amountMicro <= 0) {
    throw new TradeError("Enter an amount greater than zero.", 400, "INVALID_AMOUNT");
  }
  if (input.side === "sell" && input.input === "usd") {
    throw new TradeError("Sells must specify a token amount.", 400, "INVALID_INPUT");
  }
  const king = isKingToken(token.id);
  const effectiveFeeBps = king ? DEVELOPER_FEE_BPS : FEE_BPS;
  const phase = token.status as "bonding" | "graduated";
  const errors: string[] = [];
  const tierConfig = TIERS[token.tier as keyof typeof TIERS];
  let tokens = 0n;
  let base = 0n;
  let fee = 0n;
  let total = 0n;
  let priceBefore = 0n;
  let priceAfter = 0n;
  let availableMicro: number | null = user ? user.usd_micro : null;
  let walletCapReached = false;
  let willGraduate = false;

  const holding = user
    ? (db
        .prepare("SELECT amount_micro FROM holdings WHERE user_id = ? AND token_id = ?")
        .get(user.id, token.id) as { amount_micro: number } | undefined)
    : undefined;

  if (phase === "bonding") {
    priceBefore = curvePriceMicro(token.tier as "seed" | "rising" | "viral", BigInt(token.sold_micro));
    const curveLimit = BigInt(GRADUATION_SOLD_MICRO) - BigInt(token.sold_micro);
    if (input.side === "buy") {
      const cap = maxWalletMicro(token.tier as "seed" | "rising" | "viral");
      const remainingCap = cap - toBigInt(holding?.amount_micro ?? 0);
      if (remainingCap <= 0n) {
        walletCapReached = true;
        errors.push(
          `Wallet holding cap reached (${(tierConfig.perWalletCapBps / 100).toFixed(1)}% of supply during the curve).`,
        );
      }
      if (input.input === "usd") {
        const grossInput = BigInt(input.amountMicro);
        if (grossInput <= 0n) throw new TradeError("Enter an amount greater than zero.", 400, "INVALID_AMOUNT");
        const theoreticalFee = feeFor(effectiveFeeBps, grossInput);
        const budget = grossInput - theoreticalFee;
        const maxOut = curveLimit < remainingCap ? curveLimit : remainingCap;
        tokens = tokensForBudget(
          token.tier as "seed" | "rising" | "viral",
          BigInt(token.sold_micro),
          budget,
          maxOut,
        );
        if (tokens <= 0n) {
          errors.push("This amount is too small to buy a single token unit.");
        } else {
          base = curveCostBetween(
            token.tier as "seed" | "rising" | "viral",
            BigInt(token.sold_micro),
            tokens,
          );
          fee = feeFor(effectiveFeeBps, base);
          total = base + fee;
          const hitLimit = tokens === maxOut && maxOut < curveLimit;
          if (hitLimit) {
            walletCapReached = true;
            errors.push(
              `This buy would exceed the ${(tierConfig.perWalletCapBps / 100).toFixed(1)}% per-wallet curve cap.`,
            );
          } else if (tokens === curveLimit) {
            const nextToken = curveCostBetween(
              token.tier as "seed" | "rising" | "viral",
              BigInt(token.sold_micro),
              tokens + 1n,
            );
            if (nextToken <= budget) {
              errors.push("This buy would cross the graduation threshold. Lower the amount or use a token-sized order.");
            }
          }
        }
      } else {
        tokens = BigInt(input.amountMicro);
        if (tokens > curveLimit) {
          errors.push(
            "This order crosses the graduation threshold and would leave the bonding curve.",
          );
          tokens = curveLimit;
        }
        if (remainingCap <= 0n) {
          tokens = 0n;
        } else if (tokens > remainingCap) {
          walletCapReached = true;
          errors.push(
            "This buy would exceed the per-wallet curve cap.",
          );
          tokens = remainingCap;
        }
        if (tokens > 0n) {
          base = curveCostBetween(
            token.tier as "seed" | "rising" | "viral",
            BigInt(token.sold_micro),
            tokens,
          );
          fee = feeFor(effectiveFeeBps, base);
          total = base + fee;
        }
      }
      willGraduate =
        tokens > 0n && BigInt(token.sold_micro) + tokens >= BigInt(GRADUATION_SOLD_MICRO);
      if (willGraduate) priceAfter = curvePriceMicro(token.tier as "seed" | "rising" | "viral", BigInt(GRADUATION_SOLD_MICRO));
      else
        priceAfter = curvePriceMicro(
          token.tier as "seed" | "rising" | "viral",
          BigInt(token.sold_micro) + tokens,
        );
    } else {
      if (!user) throw new TradeError("Connect a wallet to trade.", 401, "AUTH_REQUIRED");
      const available = availableTokens(user.id, token.id);
      availableMicro = Number(available);
      tokens = BigInt(input.amountMicro);
      if (tokens > available) {
        errors.push("You do not have enough unlocked, unstaked tokens.");
        tokens = available > 0n ? available : 0n;
      }
      if (tokens > BigInt(token.sold_micro)) {
        errors.push("Sell amount exceeds the curve's available inventory.");
        tokens = BigInt(token.sold_micro);
      }
      if (tokens > 0n) {
        const sell = quoteCurveSell(
          token.tier as "seed" | "rising" | "viral",
          BigInt(token.sold_micro),
          tokens,
        );
        base = sell.grossMicro;
        fee = feeFor(effectiveFeeBps, base);
        total = base - fee;
        priceAfter = curvePriceMicro(
          token.tier as "seed" | "rising" | "viral",
          BigInt(token.sold_micro) - tokens,
        );
      }
    }
  } else {
    const poolQuote = toBigInt(token.pool_quote_micro);
    const poolToken = toBigInt(token.pool_token_micro);
    priceBefore = (poolQuote * 1_000_000n) / poolToken;
    if (input.side === "buy") {
      if (input.input === "usd") {
        const grossInput = BigInt(input.amountMicro);
        const theoreticalFee = feeFor(effectiveFeeBps, grossInput);
        const net = grossInput - theoreticalFee;
        tokens = (poolToken * net) / (poolQuote + net);
        base = net;
        fee = feeFor(effectiveFeeBps, base);
        total = base + fee;
      } else {
        tokens = BigInt(input.amountMicro);
        if (tokens >= poolToken) throw new TradeError("Order is larger than the DEX pool.", 400, "POOL_TOO_SMALL");
        base = (poolQuote * tokens) / (poolToken - tokens);
        fee = feeFor(effectiveFeeBps, base);
        total = base + fee;
      }
      const newQuote = poolQuote + base;
      const newToken = poolToken - tokens;
      priceAfter = (newQuote * 1_000_000n) / newToken;
    } else {
      if (!user) throw new TradeError("Connect a wallet to trade.", 401, "AUTH_REQUIRED");
      const available = availableTokens(user.id, token.id);
      availableMicro = Number(available);
      tokens = BigInt(input.amountMicro);
      if (tokens > available) {
        errors.push("You do not have enough unlocked, unstaked tokens.");
        tokens = available > 0n ? available : 0n;
      }
      if (tokens > 0n) {
        const sell = quoteDexSell(poolQuote, poolToken, tokens);
        base = sell.grossMicro;
        fee = feeFor(effectiveFeeBps, base);
        total = base - fee;
        const newQuote = poolQuote - base;
        const newToken = poolToken + tokens;
        priceAfter = (newQuote * 1_000_000n) / newToken;
      }
    }
  }

  const split = splitFee(fee, king, PLATFORM_YIELD_SHARE_BPS);
  const pub = publicQuote({
    side: input.side,
    phase,
    tokens,
    base,
    fee,
    total,
    priceBefore,
    priceAfter,
    token,
    errors,
    walletCapTokensMicro:
      phase === "bonding"
        ? Number(maxWalletMicro(token.tier as "seed" | "rising" | "viral"))
        : null,
    availableMicro,
    walletCapReached,
    willGraduate,
    split,
  });
  return {
    public: pub,
    feeParts: split,
    tokens,
    base,
    fee,
    total,
    priceBefore,
    priceAfter,
    phase,
    willGraduate,
    king,
  };
}

export interface ExecuteTradeResult {
  trade: Trade;
  quote: QuoteResponse;
  token: TokenRow;
  events: Array<{ type: string; data: unknown }>;
}

export function executeTrade(
  user: UserRow,
  tokenId: string,
  input: TradeInput,
  idempotencyKey?: string,
): ExecuteTradeResult {
  if (isPaused()) throw new TradeError("Trading is paused by the emergency circuit breaker.", 503, "PAUSED");
  if (idempotencyKey) {
    const duplicate = db
      .prepare("SELECT response_json FROM idempotency_keys WHERE key = ? AND user_id = ?")
      .get(idempotencyKey, user.id) as { response_json: string } | undefined;
    if (duplicate) {
      return JSON.parse(duplicate.response_json) as ExecuteTradeResult;
    }
  }
  const result = withTransaction(() => {
    const token = getTokenById(tokenId);
    if (!token) throw new TradeError("Token not found.", 404, "TOKEN_NOT_FOUND");
    const freshUser = db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(user.id) as UserRow | undefined;
    if (!freshUser) throw new TradeError("Session is no longer valid.", 401, "AUTH_REQUIRED");
    const quote = buildQuote(token, freshUser, input);
    if (quote.tokens <= 0n) {
      throw new TradeError(
        quote.public.errors[0] ?? "This order cannot be filled.",
        422,
        "UNFILLABLE",
        { quote: quote.public },
      );
    }
    if (quote.public.errors.length > 0) {
      throw new TradeError(quote.public.errors[0]!, 422, "QUOTE_OUT_OF_BOUNDS", {
        quote: quote.public,
      });
    }
    if (input.minOutMicro !== undefined) {
      const out = input.side === "buy" ? quote.public.tokensMicro : quote.public.totalMicro;
      if (out < input.minOutMicro) {
        throw new TradeError(
          "Price moved beyond your slippage tolerance. Refresh the quote and retry.",
          409,
          "SLIPPAGE_EXCEEDED",
          { expected: out, minimum: input.minOutMicro },
        );
      }
    }
    if (input.side === "buy" && toBigInt(freshUser.usd_micro) < quote.total) {
      throw new TradeError("Insufficient USDC balance. Top up your demo balance and try again.", 402, "INSUFFICIENT_FUNDS");
    }
    if (input.side === "sell") {
      const available = availableTokens(freshUser.id, token.id);
      if (quote.tokens > available) {
        throw new TradeError("You do not have enough unlocked, unstaked tokens.", 422, "INSUFFICIENT_TOKENS");
      }
    }
    return settleTradeInTransaction(token, freshUser, quote, input);
  });
  if (idempotencyKey) {
    db.prepare(
      "INSERT OR REPLACE INTO idempotency_keys(key, user_id, endpoint, response_json, created_at) VALUES (?, ?, 'trade', ?, ?)",
    ).run(idempotencyKey, user.id, JSON.stringify(result), nowIso());
  }
  return result;
}

function settleTradeInTransaction(
  token: TokenRow,
  user: UserRow,
  quote: QuoteInternal,
  input: TradeInput,
): ExecuteTradeResult {
  const now = nowIso();
  const tokenId = token.id;
  const tokens = quote.tokens;
  const base = quote.base;
  const fee = quote.fee;
  const total = quote.total;
  const tradeId = randomId("trd_");
  const txHash = crypto
    .createHash("sha256")
    .update(`${tradeId}|${tokenId}|${user.address}|${input.side}|${tokens}|${base}|${now}`)
    .digest("hex");
  const phaseBefore = token.status as "bonding" | "graduated";
  const holdingBefore = db
    .prepare("SELECT * FROM holdings WHERE user_id = ? AND token_id = ?")
    .get(user.id, tokenId) as
    | {
        amount_micro: number;
        cost_micro: number;
        realized_pnl_micro: number;
        vesting_locked_micro: number;
        vesting_until: string | null;
      }
    | undefined;
  let newAmount = toBigInt(holdingBefore?.amount_micro ?? 0);
  let newCost = toBigInt(holdingBefore?.cost_micro ?? 0);
  let realized = toBigInt(holdingBefore?.realized_pnl_micro ?? 0);
  let vestingLocked = toBigInt(holdingBefore?.vesting_locked_micro ?? 0);
  let vestingUntil = holdingBefore?.vesting_until ?? null;
  if (vestingUntil && new Date(vestingUntil).getTime() <= Date.now()) {
    vestingLocked = 0n;
    vestingUntil = null;
  }
  let balanceDelta = 0n;
  let realizedDelta = 0n;

  if (input.side === "buy") {
    balanceDelta = -total;
    newAmount += tokens;
    newCost += total;
  } else {
    balanceDelta = total;
    const sold = tokens;
    const oldAmount = newAmount;
    const costReduction = oldAmount > 0n ? (newCost * sold) / oldAmount : 0n;
    realizedDelta = total - costReduction;
    realized += realizedDelta;
    newCost -= costReduction;
    newAmount -= sold;
    if (vestingLocked > newAmount) vestingLocked = newAmount;
  }

  if (
    input.side === "buy" &&
    phaseBefore === "bonding" &&
    token.owner_wallet &&
    token.owner_wallet === user.address
  ) {
    const days = TIERS[token.tier as keyof typeof TIERS].vestingDays;
    vestingLocked += tokens;
    const candidate = new Date(Date.now() + days * 86_400_000).toISOString();
    if (!vestingUntil || candidate > vestingUntil) vestingUntil = candidate;
  }

  if (newAmount === 0n) {
    db.prepare("DELETE FROM holdings WHERE user_id = ? AND token_id = ?").run(user.id, tokenId);
  } else {
    db.prepare(
      `INSERT INTO holdings(user_id, token_id, amount_micro, cost_micro, realized_pnl_micro, vesting_locked_micro, vesting_until, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, token_id) DO UPDATE SET
         amount_micro = excluded.amount_micro, cost_micro = excluded.cost_micro,
         realized_pnl_micro = excluded.realized_pnl_micro,
         vesting_locked_micro = excluded.vesting_locked_micro,
         vesting_until = excluded.vesting_until, updated_at = excluded.updated_at`,
    ).run(
      user.id,
      tokenId,
      Number(newAmount),
      Number(newCost),
      Number(realized),
      Number(vestingLocked),
      vestingUntil,
      now,
    );
  }

  const newBalance = toBigInt(user.usd_micro) + balanceDelta;
  if (newBalance < 0n) throw new TradeError("Insufficient balance.", 402, "INSUFFICIENT_FUNDS");
  db.prepare("UPDATE users SET usd_micro = ?, xp = xp + ?, realized_pnl_micro = realized_pnl_micro + ?, updated_at = ? WHERE id = ?").run(
    Number(newBalance),
    Math.max(1, Math.floor(Number(total) / 100_000)),
    Number(realizedDelta),
    now,
    user.id,
  );

  const devFee = quote.feeParts.developer;
  let platformNet = quote.feeParts.platformNet;
  let referral = 0n;
  if (user.referrer_id && platformNet > 0n) {
    referral = (platformNet * BigInt(REFERRAL_SHARE_BPS)) / BigInt(BPS);
    platformNet -= referral;
    const ref = db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(user.referrer_id) as UserRow | undefined;
    if (ref) {
      db.prepare(
        `INSERT INTO earnings(id, user_id, wallet, token_id, source, amount_micro, created_at)
         VALUES (?, ?, ?, ?, 'referral', ?, ?)`,
      ).run(randomId("ern_"), ref.id, ref.address, tokenId, Number(referral), now);
      db.prepare("UPDATE users SET xp = xp + 10 WHERE id = ?").run(ref.id);
    }
  }
  if (devFee > 0n) {
    if (token.owner_wallet) {
      const owner = getUserByAddress(token.owner_wallet);
      if (owner) {
        db.prepare(
          `INSERT INTO earnings(id, user_id, wallet, token_id, source, amount_micro, created_at)
           VALUES (?, ?, ?, ?, 'developer', ?, ?)`,
        ).run(randomId("ern_"), owner.id, owner.address, tokenId, Number(devFee), now);
      } else {
        db.prepare(
          "UPDATE tokens SET unclaimed_dev_vault_micro = unclaimed_dev_vault_micro + ? WHERE id = ?",
        ).run(Number(devFee), tokenId);
      }
    } else {
      db.prepare(
        "UPDATE tokens SET unclaimed_dev_vault_micro = unclaimed_dev_vault_micro + ? WHERE id = ?",
      ).run(Number(devFee), tokenId);
    }
  }

  const feeEventId = randomId("fee_");
  let currentToken = token;
  if (phaseBefore === "bonding") {
    const nextSold = BigInt(token.sold_micro) + tokens;
    if (nextSold > BigInt(GRADUATION_SOLD_MICRO)) {
      throw new TradeError("Order would cross graduation bounds.", 422, "GRADUATION_BOUNDS");
    }
    const nextReserve = curveCostFromZero(token.tier as "seed" | "rising" | "viral", nextSold);
    const nextPrice = curvePriceMicro(token.tier as "seed" | "rising" | "viral", nextSold);
    db.prepare(
      "UPDATE tokens SET sold_micro = ?, reserve_micro = ?, last_price_micro = ?, volume_total_micro = volume_total_micro + ?, volume_24h_micro = volume_24h_micro + ?, updated_at = ? WHERE id = ?",
    ).run(
      Number(nextSold),
      Number(nextReserve),
      Number(nextPrice),
      Number(base),
      Number(base),
      now,
      tokenId,
    );
    currentToken = getTokenById(tokenId)!;
    if (quote.willGraduate) {
      currentToken = graduateToken(currentToken, now, false);
    }
  } else {
    const nextPoolQuote = BigInt(token.pool_quote_micro) + (input.side === "buy" ? base : -base);
    const nextPoolToken =
      input.side === "buy"
        ? BigInt(token.pool_token_micro) - tokens
        : BigInt(token.pool_token_micro) + tokens;
    const nextPrice = (nextPoolQuote * 1_000_000n) / nextPoolToken;
    db.prepare(
      "UPDATE tokens SET pool_quote_micro = ?, pool_token_micro = ?, last_price_micro = ?, volume_total_micro = volume_total_micro + ?, volume_24h_micro = volume_24h_micro + ?, updated_at = ? WHERE id = ?",
    ).run(
      Number(nextPoolQuote),
      Number(nextPoolToken),
      Number(nextPrice),
      Number(base),
      Number(base),
      now,
      tokenId,
    );
    currentToken = getTokenById(tokenId)!;
  }

  const holderCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM holdings WHERE token_id = ? AND amount_micro > 0",
      )
      .get(tokenId) as { count: number }
  ).count;
  db.prepare("UPDATE tokens SET holder_count = ? WHERE id = ?").run(holderCount, tokenId);

  db.prepare(
    `INSERT INTO trades(id, token_id, user_id, wallet, side, phase, token_micro, usd_micro, fee_micro, price_micro, fee_event_id, tx_hash, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tradeId,
    tokenId,
    user.id,
    user.address,
    input.side,
    phaseBefore,
    Number(tokens),
    Number(base),
    Number(fee),
    Number((base * 1_000_000n) / tokens),
    null,
    txHash,
    null,
    now,
  );

  db.prepare(
    `INSERT INTO fee_events(id, trade_id, token_id, dev_fee_micro, platform_gross_micro, dividend_micro, platform_net_micro, referral_micro, dev_to_vault, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    feeEventId,
    tradeId,
    tokenId,
    Number(devFee),
    Number(quote.feeParts.platformGross),
    Number(quote.feeParts.dividend),
    Number(platformNet),
    Number(referral),
    token.owner_wallet ? 0 : 1,
    now,
  );
  db.prepare("UPDATE trades SET fee_event_id = ? WHERE id = ?").run(feeEventId, tradeId);
  if (quote.feeParts.dividend > 0n) {
    distributeDividend(token, quote.feeParts.dividend, tradeId, now);
  }

  const newPrice = currentToken.last_price_micro;
  db.prepare(
    `INSERT INTO price_points(token_id, time, price_micro, volume_micro, type, label, trade_id)
     VALUES (?, ?, ?, ?, 'trade', NULL, ?)`,
  ).run(tokenId, Date.now(), newPrice, Number(base), tradeId);

  const ticker = currentToken.ticker;
  const action = input.side === "buy" ? "bought" : "sold";
  const tokenAmount = (Number(tokens) / 1_000_000).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });
  const usdAmount = (Number(total) / 1_000_000).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
  db.prepare(
    `INSERT INTO activities(id, token_id, type, actor_wallet, message, metadata_json, created_at)
     VALUES (?, ?, 'trade', ?, ?, ?, ?)`,
  ).run(
    randomId("act_"),
    tokenId,
    user.address,
    `${action} ${tokenAmount} $${ticker} for ${usdAmount}`,
    JSON.stringify({ side: input.side, tradeId, usdMicro: Number(base) }),
    now,
  );

  const receipt = appendReceipt("trade.settle", tokenId, {
    tradeId,
    tokenId,
    wallet: user.address,
    side: input.side,
    phase: phaseBefore,
    tokenMicro: Number(tokens),
    baseMicro: Number(base),
    feeMicro: Number(fee),
    devFeeMicro: Number(devFee),
    platformFeeMicro: Number(platformNet),
    dividendMicro: Number(quote.feeParts.dividend),
    referralMicro: Number(referral),
    txHash,
  });

  queueReceiptAnchor({
    kind: "trade.settle",
    aggregate: tokenId,
    digest: receipt.digest,
    subjectId: tradeId,
  });

  const trade = db.prepare("SELECT * FROM trades WHERE id = ?").get(tradeId) as {
    id: string;
    side: string;
    wallet: string;
    token_micro: number;
    usd_micro: number;
    fee_micro: number;
    price_micro: number;
    phase: string;
    tx_hash: string;
    created_at: string;
  };

  return {
    trade: {
      id: trade.id,
      side: trade.side as "buy" | "sell",
      wallet: trade.wallet,
      displayName: user.display_name,
      tokensMicro: trade.token_micro,
      usdMicro: trade.usd_micro,
      feeMicro: trade.fee_micro,
      priceMicro: trade.price_micro,
      phase: trade.phase as "curve" | "dex",
      txHash: trade.tx_hash,
      createdAt: trade.created_at,
    },
    quote: quote.public,
    token: currentToken,
    events: [
      {
        type: "trade",
        data: {
          tokenId,
          slug: currentToken.slug,
          ticker: currentToken.ticker,
          side: input.side,
          priceMicro: newPrice,
          tokensMicro: Number(tokens),
          usdMicro: Number(base),
          wallet: user.address,
          txHash,
          receipt: receipt.digest,
          volume1hMicro: null,
        },
      },
      {
        type: "token",
        data: {
          tokenId,
          status: currentToken.status,
          priceMicro: currentToken.last_price_micro,
          marketCapMicro:
            (currentToken.last_price_micro *
              (currentToken.total_supply_micro - currentToken.burned_micro)) /
            1_000_000,
          progressBps:
            currentToken.status === "graduated"
              ? 10_000
              : Math.floor((currentToken.sold_micro * 10_000) / GRADUATION_SOLD_MICRO),
          volume24hMicro: currentToken.volume_24h_micro,
          holderCount,
          graduatedAt: currentToken.graduated_at,
        },
      },
    ],
  };
}

function distributeDividend(
  token: TokenRow,
  amount: bigint,
  tradeId: string | null,
  now: string,
): void {
  if (amount <= 0n) return;
  const totalStaked =
    (db
      .prepare("SELECT COALESCE(SUM(amount_micro),0) AS amount FROM stakes WHERE token_id = ?")
      .get(token.id) as { amount: number }).amount;
  const acc = toBigInt(token.dividend_acc_scaled);
  if (totalStaked <= 0) {
    db.prepare(
      "UPDATE tokens SET pending_yield_micro = pending_yield_micro + ? WHERE id = ?",
    ).run(Number(amount), token.id);
  } else {
    const increment = (amount * 1_000_000_000_000_000_000n) / toBigInt(totalStaked);
    db.prepare("UPDATE tokens SET dividend_acc_scaled = ? WHERE id = ?").run(
      String(acc + increment),
      token.id,
    );
  }
  db.prepare(
    "INSERT INTO dividend_events(id, token_id, trade_id, amount_micro, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(randomId("dvd_"), token.id, tradeId, Number(amount), now);
}

export function graduateToken(token: TokenRow, now: string, simulate = false): TokenRow {
  const tier = token.tier as "seed" | "rising" | "viral";
  const reserve = toBigInt(token.reserve_micro);
  const poolTokens = graduationPoolTokensMicro();
  const burn = graduationBurnMicro();
  const price = (reserve * 1_000_000n) / poolTokens;
  if (!simulate) {
    db.prepare(
      `UPDATE tokens SET status = 'graduated', graduated_at = ?, pool_quote_micro = ?, pool_token_micro = ?,
       burned_micro = burned_micro + ?, last_price_micro = ?, updated_at = ? WHERE id = ?`,
    ).run(
      now,
      Number(reserve),
      Number(poolTokens),
      Number(burn),
      Number(price),
      now,
      token.id,
    );
    db.prepare(
      `INSERT INTO price_points(token_id, time, price_micro, volume_micro, type, label)
       VALUES (?, ?, ?, 0, 'graduation', 'DEX graduation')`,
    ).run(token.id, Date.now(), Number(price));
    db.prepare(
      `INSERT INTO activities(id, token_id, type, actor_wallet, message, metadata_json, created_at)
       VALUES (?, ?, 'graduation', NULL, ?, ?, ?)`,
    ).run(
      randomId("act_"),
      token.id,
      `$${token.ticker} graduated to the DEX with $${(Number(reserve) / 1_000_000).toLocaleString("en-US")} of investor-funded liquidity`,
      JSON.stringify({ priceMicro: Number(price), poolTokens: Number(poolTokens) }),
      now,
    );
    const graduationReceipt = appendReceipt("token.graduate", token.id, {
      tokenId: token.id,
      tier,
      reserveMicro: Number(reserve),
      poolTokensMicro: Number(poolTokens),
      burnMicro: Number(burn),
      priceMicro: Number(price),
    });
    queueReceiptAnchor({
      kind: "token.graduate",
      aggregate: token.id,
      digest: graduationReceipt.digest,
      subjectId: token.id,
    });
  }
  return getTokenById(token.id)!;
}

export interface StakeResult {
  amountMicro: number;
  totalStakedMicro: number;
  unlockAt: string;
  xpAwarded: number;
  receipt: string;
}

const LOCK_MULTIPLIERS: Record<number, number> = { 7: 10_000, 30: 12_500, 90: 15_000 };
const LOCK_XP: Record<number, number> = { 7: 50, 30: 150, 90: 400 };

export function stakeTokens(
  user: UserRow,
  tokenId: string,
  amountMicro: number,
  lockDays: number,
): StakeResult {
  if (![7, 30, 90].includes(lockDays)) {
    throw new TradeError("Choose a 7, 30 or 90 day lock.", 400, "INVALID_LOCK");
  }
  if (!Number.isSafeInteger(amountMicro) || amountMicro <= 0) {
    throw new TradeError("Enter a token amount to stake.", 400, "INVALID_AMOUNT");
  }
  return withTransaction(() => {
    const token = getTokenById(tokenId);
    if (!token) throw new TradeError("Token not found.", 404, "TOKEN_NOT_FOUND");
    if (token.status === "prelaunch" || token.status === "frozen") {
      throw new TradeError("This market is not open for staking yet.", 422, "NOT_STAKEABLE");
    }
    const holding = db
      .prepare("SELECT * FROM holdings WHERE user_id = ? AND token_id = ?")
      .get(user.id, tokenId) as
      | { amount_micro: number; vesting_locked_micro: number; vesting_until: string | null }
      | undefined;
    if (!holding) throw new TradeError("You do not hold this token.", 422, "NO_HOLDING");
    const existing = db
      .prepare("SELECT * FROM stakes WHERE user_id = ? AND token_id = ?")
      .get(user.id, tokenId) as
      | {
          id: string;
          amount_micro: number;
          lock_days: number;
          multiplier_bps: number;
          reward_debt_scaled: string;
          unlock_at: string;
        }
      | undefined;
    const free =
      toBigInt(holding.amount_micro) -
      toBigInt(existing?.amount_micro ?? 0) -
      toBigInt(activeVesting(holding));
    if (toBigInt(amountMicro) > free) {
      throw new TradeError(
        "That amount is locked by vesting or already staked. Choose your available balance.",
        422,
        "INSUFFICIENT_FREE_TOKENS",
      );
    }
    const now = nowIso();
    const acc = toBigInt(token.dividend_acc_scaled);
    let rewardDebt = acc;
    if (existing) {
      const pending = pendingStakeDividends(
        toBigInt(existing.amount_micro),
        toBigInt(existing.reward_debt_scaled),
        acc,
      );
      if (pending > 0n) {
        db.prepare(
          `INSERT INTO earnings(id, user_id, wallet, token_id, source, amount_micro, created_at)
           VALUES (?, ?, ?, ?, 'dividend', ?, ?)`,
        ).run(randomId("ern_"), user.id, user.address, tokenId, Number(pending), now);
      }
    }
    const previousTotal = (
      db
        .prepare("SELECT COALESCE(SUM(amount_micro),0) AS amount FROM stakes WHERE token_id = ?")
        .get(tokenId) as { amount: number }
    ).amount;
    const chosenMultiplier = Math.max(
      LOCK_MULTIPLIERS[lockDays] ?? 10_000,
      existing?.multiplier_bps ?? 0,
    );
    const newUnlock = new Date(
      Math.max(
        Date.now() + lockDays * 86_400_000,
        existing ? new Date(existing.unlock_at).getTime() : 0,
      ),
    ).toISOString();
    if (existing) {
      db.prepare(
        `UPDATE stakes SET amount_micro = amount_micro + ?, lock_days = ?, multiplier_bps = ?,
         reward_debt_scaled = ?, unlock_at = ?, updated_at = ? WHERE id = ?`,
      ).run(
        amountMicro,
        Math.max(lockDays, existing.lock_days),
        chosenMultiplier,
        String(acc),
        newUnlock,
        now,
        existing.id,
      );
    } else {
      db.prepare(
        `INSERT INTO stakes(id, user_id, token_id, amount_micro, lock_days, multiplier_bps, reward_debt_scaled, started_at, unlock_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomId("stk_"),
        user.id,
        tokenId,
        amountMicro,
        lockDays,
        chosenMultiplier,
        String(acc),
        now,
        newUnlock,
        now,
      );
    }
    const totalStaked = previousTotal + amountMicro;
    db.prepare("UPDATE tokens SET total_staked_micro = ? WHERE id = ?").run(totalStaked, tokenId);
    db.prepare("UPDATE users SET xp = xp + ? WHERE id = ?").run(
      LOCK_XP[lockDays] ?? 50,
      user.id,
    );

    if (previousTotal === 0 && token.pending_yield_micro > 0 && totalStaked > 0) {
      const pendingYield = toBigInt(token.pending_yield_micro);
      const increment = (pendingYield * 1_000_000_000_000_000_000n) / toBigInt(totalStaked);
      db.prepare(
        "UPDATE tokens SET dividend_acc_scaled = ?, pending_yield_micro = 0 WHERE id = ?",
      ).run(String(acc + increment), tokenId);
      db.prepare(
        "INSERT INTO dividend_events(id, token_id, trade_id, amount_micro, created_at) VALUES (?, ?, NULL, ?, ?)",
      ).run(randomId("dvd_"), tokenId, Number(pendingYield), now);
      db.prepare(
        "UPDATE stakes SET reward_debt_scaled = ? WHERE user_id = ? AND token_id = ?",
      ).run(String(acc), user.id, tokenId);
    } else {
      db.prepare(
        "UPDATE stakes SET reward_debt_scaled = ? WHERE user_id = ? AND token_id = ?",
      ).run(String(acc), user.id, tokenId);
    }

    db.prepare(
      `INSERT INTO activities(id, token_id, type, actor_wallet, message, metadata_json, created_at)
       VALUES (?, ?, 'stake', ?, ?, ?, ?)`,
    ).run(
      randomId("act_"),
      tokenId,
      user.address,
      `staked ${(amountMicro / 1_000_000).toLocaleString()} $${token.ticker} for ${lockDays} days`,
      JSON.stringify({ amountMicro, lockDays }),
      now,
    );
    const receipt = appendReceipt("stake.lock", tokenId, {
      user: user.address,
      tokenId,
      amountMicro,
      lockDays,
      unlockAt: newUnlock,
    });
    return {
      amountMicro,
      totalStakedMicro: totalStaked,
      unlockAt: newUnlock,
      xpAwarded: LOCK_XP[lockDays] ?? 50,
      receipt: receipt.digest,
    };
  });
}

export function unstakeTokens(user: UserRow, tokenId: string, amountMicro: number): StakeResult {
  return withTransaction(() => {
    const token = getTokenById(tokenId);
    if (!token) throw new TradeError("Token not found.", 404, "TOKEN_NOT_FOUND");
    const stake = db
      .prepare("SELECT * FROM stakes WHERE user_id = ? AND token_id = ?")
      .get(user.id, tokenId) as
      | {
          id: string;
          amount_micro: number;
          lock_days: number;
          multiplier_bps: number;
          reward_debt_scaled: string;
          unlock_at: string;
        }
      | undefined;
    if (!stake) throw new TradeError("No active stake found.", 404, "NO_STAKE");
    if (new Date(stake.unlock_at).getTime() > Date.now()) {
      throw new TradeError(
        `This stake unlocks ${new Date(stake.unlock_at).toLocaleString()}.`,
        422,
        "STAKE_LOCKED",
      );
    }
    const amount = Math.min(amountMicro, stake.amount_micro);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new TradeError("Enter a valid amount.", 400, "INVALID_AMOUNT");
    }
    const now = nowIso();
    const acc = toBigInt(token.dividend_acc_scaled);
    const pending = pendingStakeDividends(
      toBigInt(stake.amount_micro),
      toBigInt(stake.reward_debt_scaled),
      acc,
    );
    if (pending > 0n) {
      db.prepare(
        `INSERT INTO earnings(id, user_id, wallet, token_id, source, amount_micro, created_at)
         VALUES (?, ?, ?, ?, 'dividend', ?, ?)`,
      ).run(randomId("ern_"), user.id, user.address, tokenId, Number(pending), now);
    }
    const remaining = stake.amount_micro - amount;
    if (remaining <= 0) {
      db.prepare("DELETE FROM stakes WHERE id = ?").run(stake.id);
    } else {
      db.prepare(
        "UPDATE stakes SET amount_micro = ?, reward_debt_scaled = ?, updated_at = ? WHERE id = ?",
      ).run(remaining, String(acc), now, stake.id);
    }
    const totalStaked = (
      db
        .prepare("SELECT COALESCE(SUM(amount_micro),0) AS amount FROM stakes WHERE token_id = ?")
        .get(tokenId) as { amount: number }
    ).amount;
    db.prepare("UPDATE tokens SET total_staked_micro = ? WHERE id = ?").run(totalStaked, tokenId);
    db.prepare("UPDATE users SET xp = xp + 15 WHERE id = ?").run(user.id);
    db.prepare(
      `INSERT INTO activities(id, token_id, type, actor_wallet, message, metadata_json, created_at)
       VALUES (?, ?, 'stake', ?, ?, ?, ?)`,
    ).run(
      randomId("act_"),
      tokenId,
      user.address,
      `unstaked ${(amount / 1_000_000).toLocaleString()} $${token.ticker}`,
      JSON.stringify({ amountMicro: amount, direction: "out" }),
      now,
    );
    const receipt = appendReceipt("stake.unlock", tokenId, {
      user: user.address,
      tokenId,
      amountMicro: amount,
    });
    return {
      amountMicro: amount,
      totalStakedMicro: totalStaked,
      unlockAt: now,
      xpAwarded: 15,
      receipt: receipt.digest,
    };
  });
}

export interface ClaimResult {
  amountMicro: number;
  breakdown: {
    developerMicro: number;
    dividendMicro: number;
    referralMicro: number;
    bountyMicro: number;
  };
  receipt: string;
  balanceMicro: number;
}

export function claimEarnings(user: UserRow): ClaimResult {
  return withTransaction(() => {
    const now = nowIso();
    const stakes = db
      .prepare(
        `SELECT s.*, t.dividend_acc_scaled FROM stakes s JOIN tokens t ON t.id = s.token_id WHERE s.user_id = ?`,
      )
      .all(user.id) as Array<{
      id: string;
      token_id: string;
      amount_micro: number;
      reward_debt_scaled: string;
      dividend_acc_scaled: string;
    }>;
    for (const stake of stakes) {
      const pending = pendingStakeDividends(
        toBigInt(stake.amount_micro),
        toBigInt(stake.reward_debt_scaled),
        toBigInt(stake.dividend_acc_scaled),
      );
      if (pending > 0n) {
        db.prepare(
          `INSERT INTO earnings(id, user_id, wallet, token_id, source, amount_micro, created_at)
           VALUES (?, ?, ?, ?, 'dividend', ?, ?)`,
        ).run(randomId("ern_"), user.id, user.address, stake.token_id, Number(pending), now);
        db.prepare("UPDATE stakes SET reward_debt_scaled = ? WHERE id = ?").run(
          stake.dividend_acc_scaled,
          stake.id,
        );
      }
    }
    const credits = db
      .prepare(
        `SELECT e.*, t.royalty_frozen, t.ticker FROM earnings e
         JOIN tokens t ON t.id = e.token_id
         WHERE e.user_id = ? AND e.claimed_at IS NULL`,
      )
      .all(user.id) as Array<{
      id: string;
      source: string;
      amount_micro: number;
      royalty_frozen: number;
    }>;
    let developer = 0n;
    let dividend = 0n;
    let referral = 0n;
    let bounty = 0n;
    const claimIds: string[] = [];
    for (const credit of credits) {
      if (credit.source === "developer" && credit.royalty_frozen) continue;
      if (credit.source === "developer") developer += toBigInt(credit.amount_micro);
      else if (credit.source === "dividend") dividend += toBigInt(credit.amount_micro);
      else if (credit.source === "referral") referral += toBigInt(credit.amount_micro);
      else bounty += toBigInt(credit.amount_micro);
      claimIds.push(credit.id);
    }
    const total = developer + dividend + referral + bounty;
    if (total <= 0n) throw new TradeError("Nothing to claim yet.", 422, "NOTHING_TO_CLAIM");
    const placeholders = claimIds.map(() => "?").join(",");
    db.prepare(
      `UPDATE earnings SET claimed_at = ? WHERE user_id = ? AND id IN (${placeholders})`,
    ).run(now, user.id, ...claimIds);
    const newBalance = toBigInt(user.usd_micro) + total;
    db.prepare("UPDATE users SET usd_micro = ?, xp = xp + ? WHERE id = ?").run(
      Number(newBalance),
      Math.max(1, Math.floor(Number(total) / 500_000)),
      user.id,
    );
    appendReceipt("earnings.claim", user.id, {
      user: user.address,
      developerMicro: Number(developer),
      dividendMicro: Number(dividend),
      referralMicro: Number(referral),
      bountyMicro: Number(bounty),
      totalMicro: Number(total),
    });
    db.prepare(
      `INSERT INTO activities(id, type, actor_wallet, message, metadata_json, created_at)
       VALUES (?, 'dividend', ?, ?, ?, ?)`,
    ).run(
      randomId("act_"),
      user.address,
      `claimed $${(Number(total) / 1_000_000).toFixed(2)} in protocol earnings`,
      JSON.stringify({
        developer: Number(developer),
        dividend: Number(dividend),
        referral: Number(referral),
        bounty: Number(bounty),
      }),
      now,
    );
    return {
      amountMicro: Number(total),
      breakdown: {
        developerMicro: Number(developer),
        dividendMicro: Number(dividend),
        referralMicro: Number(referral),
        bountyMicro: Number(bounty),
      },
      receipt: appendReceipt("claim.settle", user.id, { totalMicro: Number(total) }).digest,
      balanceMicro: Number(newBalance),
    };
  });
}

export function refreshVolume24h(): void {
  const rows = db
    .prepare(
      `SELECT token_id, COALESCE(SUM(usd_micro),0) AS volume FROM trades
       WHERE created_at >= ? GROUP BY token_id`,
    )
    .all(new Date(Date.now() - 24 * 3600 * 1000).toISOString()) as Array<{
    token_id: string;
    volume: number;
  }>;
  db.prepare("UPDATE tokens SET volume_24h_micro = 0").run();
  const stmt = db.prepare("UPDATE tokens SET volume_24h_micro = ? WHERE id = ?");
  for (const row of rows) stmt.run(Number(row.volume), row.token_id);
}

