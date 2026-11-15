import { config } from "./config.js";
import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import fs from "node:fs";
import path from "node:path";
import { getNearUsd, yoctoToUsdMicro } from "./near-price.js";
import { rpcTargets, rpcTarget, type RpcTarget } from "./rpc.js";

const YOCTO = 10n ** 24n;
const MICRO = 1_000_000n;
const BPS = 10_000n;

async function callView<T>(
  target: RpcTarget,
  method: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(target.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...target.headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: config.nearMarketContractId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json()) as {
    result?: { result?: number[] };
    error?: { message?: string };
  };
  if (payload.error) throw new Error(payload.error.message ?? "NEAR view failed");
  const bytes = payload.result?.result ?? [];
  const text = Buffer.from(bytes).toString("utf8");
  if (!text) return null as T;
  const safe = text.replace(/:(\s*)(-?\d{16,})(?=\s*[,}])/g, ':"$2"');
  return JSON.parse(safe) as T;
}

export async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
  let lastError: unknown = null;
  for (const target of rpcTargets()) {
    try {
      return await callView<T>(target, method, args);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("NEAR view failed");
}

export interface OnChainMarket {
  tokenId: string;
  repo: string;
  ticker: string;
  owner: string | null;
  price: string;
  step: string;
  reserve: string;
  sold: string;
  totalSupply: string;
  curveSupply: string;
  status: string;
  createdAt: string;
}

export interface OnChainTrade {
  id: string;
  tokenId: string;
  accountId: string;
  side: "buy" | "sell";
  nearAmount: string;
  tokenAmount: string;
  price: string;
  timestamp: string;
}

export interface OnChainBounty {
  id: string;
  tokenId: string;
  creator: string;
  title: string;
  description: string;
  reward: string;
  status: string;
  winner: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface OnChainMarketStats {
  priceNear: string;
  priceUsdMicro: number;
  marketCapNear: string;
  marketCapUsdMicro: number;
  volume24hNear: string;
  volume24hUsdMicro: number;
  volumeTotalNear: string;
  volumeTotalUsdMicro: number;
  change24hBps: number;
  holderCount: number;
  progressBps: number;
  lastTradeAt: string | null;
  tradeCount: number;
  sparkline: number[];
}

export interface OnChainChartPoint {
  time: number;
  price: number;
  kind: "launch" | "trade" | "current";
}

export interface OnChainMarketDetail {
  contractId: string;
  network: string;
  nearUsd: number;
  nearUsdSource: string;
  nearUsdUpdatedAt: number;
  market: OnChainMarket | null;
  stats: OnChainMarketStats | null;
  balance: string;
  cost: string;
  stake: string;
  pendingRewards: string;
  totalStaked: string;
  trades: OnChainTrade[];
  holders: Array<{ accountId: string; tokenAmount: string; shareBps: number }>;
  bounties: OnChainBounty[];
  chart: OnChainChartPoint[];
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "0";
  return String(value);
}

export function normalizeMarket(raw: Record<string, unknown>): OnChainMarket {
  return {
    tokenId: String(raw.token_id ?? ""),
    repo: String(raw.repo ?? ""),
    ticker: String(raw.ticker ?? ""),
    owner: raw.owner ? String(raw.owner) : null,
    price: stringify(raw.price),
    step: stringify(raw.step),
    reserve: stringify(raw.reserve),
    sold: stringify(raw.sold),
    totalSupply: stringify(raw.total_supply),
    curveSupply: stringify(raw.curve_supply),
    status: String(raw.status ?? "bonding"),
    createdAt: stringify(raw.created_at),
  };
}

export function normalizeTrade(raw: Record<string, unknown>): OnChainTrade {
  return {
    id: stringify(raw.id),
    tokenId: String(raw.token_id ?? ""),
    accountId: String(raw.account_id ?? ""),
    side: String(raw.side) === "sell" ? "sell" : "buy",
    nearAmount: stringify(raw.near_amount),
    tokenAmount: stringify(raw.token_amount),
    price: stringify(raw.price),
    timestamp: stringify(raw.timestamp),
  };
}

function normalizeBounty(raw: Record<string, unknown>): OnChainBounty {
  return {
    id: stringify(raw.id),
    tokenId: String(raw.token_id ?? ""),
    creator: String(raw.creator ?? ""),
    title: String(raw.title ?? ""),
    description: String(raw.description ?? ""),
    reward: stringify(raw.reward),
    status: String(raw.status ?? "open"),
    winner: raw.winner ? String(raw.winner) : null,
    createdAt: stringify(raw.created_at),
    paidAt: raw.paid_at ? stringify(raw.paid_at) : null,
  };
}

function timestampMs(value: string): number {
  return Number(BigInt(value || "0") / 1_000_000n);
}

function sortTradesAsc(trades: OnChainTrade[]): OnChainTrade[] {
  return [...trades].sort((a, b) => {
    const diff = BigInt(a.timestamp || "0") - BigInt(b.timestamp || "0");
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return Number(BigInt(a.id || "0") - BigInt(b.id || "0"));
  });
}

function reconstructInitialPrice(market: OnChainMarket, tradesAsc: OnChainTrade[]): bigint {
  const step = BigInt(market.step || "0");
  let price = BigInt(market.price || "0");
  for (let index = tradesAsc.length - 1; index >= 0; index -= 1) {
    const trade = tradesAsc[index]!;
    if (trade.side === "buy") {
      price = price > step ? price - step : 1n;
    } else {
      price += step;
    }
  }
  return price > 0n ? price : 1n;
}

export function deriveMarketStats(
  market: OnChainMarket,
  tradesAsc: OnChainTrade[],
  nearUsd: number,
): OnChainMarketStats {
  const price = BigInt(market.price || "0");
  const priceNear = price * MICRO;
  const priceUsd = nearUsd > 0 ? (Number(priceNear) / Number(YOCTO)) * nearUsd : 0;
  const priceUsdMicro = Math.round(priceUsd * 1_000_000);
  const totalSupplyMicro = BigInt(market.totalSupply || "0");
  const marketCapNear = (priceNear * totalSupplyMicro) / MICRO;
  const marketCapUsdMicro = Math.round(
    (Number(marketCapNear) / Number(YOCTO)) * nearUsd * 1_000_000,
  );
  const initialPrice = reconstructInitialPrice(market, tradesAsc);

  const now = Date.now();
  const cutoff = BigInt(now - 24 * 3_600_000) * 1_000_000n;
  let volume24h = 0n;
  let volumeTotal = 0n;
  let baselinePrice: bigint | null = null;
  const balances = new Map<string, bigint>();
  const allPrices: number[] = [];
  if (nearUsd > 0) {
    const launchUsd = (Number(initialPrice * MICRO) / Number(YOCTO)) * nearUsd;
    allPrices.push(Math.round(launchUsd * 1_000_000));
  }

  for (const trade of tradesAsc) {
    const near = BigInt(trade.nearAmount || "0");
    const tokens = BigInt(trade.tokenAmount || "0");
    volumeTotal += near;
    if (BigInt(trade.timestamp || "0") >= cutoff) volume24h += near;
    if (BigInt(trade.timestamp || "0") <= cutoff) baselinePrice = BigInt(trade.price || "0");
    const current = balances.get(trade.accountId) ?? 0n;
    const next = trade.side === "buy" ? current + tokens : current - tokens;
    balances.set(trade.accountId, next);
    if (nearUsd > 0) {
      const wholeUsd = (Number(BigInt(trade.price || "0") * MICRO) / Number(YOCTO)) * nearUsd;
      allPrices.push(Math.round(wholeUsd * 1_000_000));
    }
  }

  const holderCount = [...balances.values()].filter((amount) => amount > 0n).length;
  const baseline = baselinePrice ?? initialPrice;
  const change24hBps =
    baseline > 0n && tradesAsc.length > 0
      ? Number(((price - baseline) * BPS) / baseline)
      : 0;
  const sold = BigInt(market.sold || "0");
  const curve = BigInt(market.curveSupply || "1");
  const progressBps = curve > 0n ? Math.min(10_000, Number((sold * BPS) / curve)) : 0;

  if (nearUsd > 0) {
    allPrices.push(priceUsdMicro);
  }
  const sparkline = allPrices.length
    ? allPrices.slice(-24)
    : [priceUsdMicro, priceUsdMicro];
  if (sparkline.length === 1) sparkline.push(priceUsdMicro);

  return {
    priceNear: priceNear.toString(),
    priceUsdMicro,
    marketCapNear: marketCapNear.toString(),
    marketCapUsdMicro,
    volume24hNear: volume24h.toString(),
    volume24hUsdMicro: yoctoToUsdMicro(volume24h, nearUsd),
    volumeTotalNear: volumeTotal.toString(),
    volumeTotalUsdMicro: yoctoToUsdMicro(volumeTotal, nearUsd),
    change24hBps,
    holderCount,
    progressBps,
    lastTradeAt: tradesAsc.length ? String(timestampMs(tradesAsc[tradesAsc.length - 1]!.timestamp)) : null,
    tradeCount: tradesAsc.length,
    sparkline,
  };
}

function holdersFromTrades(tradesAsc: OnChainTrade[]): Array<{
  accountId: string;
  tokenAmount: string;
  shareBps: number;
}> {
  const balances = new Map<string, bigint>();
  for (const trade of tradesAsc) {
    const current = balances.get(trade.accountId) ?? 0n;
    const tokens = BigInt(trade.tokenAmount || "0");
    balances.set(
      trade.accountId,
      trade.side === "buy" ? current + tokens : current - tokens,
    );
  }
  const positive = [...balances.entries()].filter(([, amount]) => amount > 0n);
  const total = positive.reduce((sum, [, amount]) => sum + amount, 0n);
  return positive
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .map(([accountId, tokenAmount]) => ({
      accountId,
      tokenAmount: tokenAmount.toString(),
      shareBps: total > 0n ? Number((tokenAmount * BPS) / total) : 0,
    }));
}

function buildChart(market: OnChainMarket, tradesAsc: OnChainTrade[]): OnChainChartPoint[] {
  const points: OnChainChartPoint[] = [];
  const launchTime = timestampMs(market.createdAt);
  points.push({
    time: launchTime,
    price: Number(reconstructInitialPrice(market, tradesAsc)),
    kind: "launch",
  });
  for (const trade of tradesAsc) {
    points.push({
      time: timestampMs(trade.timestamp),
      price: Number(BigInt(trade.price || "0")),
      kind: "trade",
    });
  }
  points.push({ time: Date.now(), price: Number(BigInt(market.price || "0")), kind: "current" });
  return points;
}

export async function createOnChainMarket(input: {
  tokenId: string;
  repo: string;
  ticker: string;
  owner: string;
  totalSupplyMicro: number;
  curveSupplyMicro: number;
  launchMarketCapUsdMicro: bigint;
  maxWalletMicro: number;
}): Promise<void> {
  const file = path.join(
    config.nearCredentialsDir,
    config.nearNetwork,
    `${config.nearOracleAccountId}.json`,
  );
  let privateKey = config.nearOraclePrivateKey;
  if (!privateKey) {
    privateKey = (JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as {
      private_key: string;
    }).private_key;
  }
  const connection = rpcTarget();
  const provider = new JsonRpcProvider(
    { url: connection.url, headers: connection.headers },
    { retries: 3 },
  );
  const account = new Account(
    config.nearOracleAccountId,
    provider,
    KeyPairSigner.fromSecretKey(privateKey as `ed25519:${string}`),
  );
  const { usd: nearUsd } = await getNearUsd();
  if (!(nearUsd > 0)) throw new Error("NEAR/USD price unavailable; cannot create a real market");
  const nearUsdMicro = BigInt(Math.max(1, Math.round(nearUsd * 1_000_000)));
  const mcNearYocto = (input.launchMarketCapUsdMicro * 10n ** 24n) / nearUsdMicro;
  const rawPrice = mcNearYocto / BigInt(input.totalSupplyMicro);
  const price = rawPrice > 0n ? rawPrice : 1n;
  const step = price / 200n > 0n ? price / 200n : 1n;
  await account.callFunction({
    contractId: config.nearMarketContractId,
    methodName: "create_market",
    args: {
      token_id: input.tokenId,
      repo: input.repo,
      ticker: input.ticker,
      mowner: input.owner,
      total_supply: String(input.totalSupplyMicro),
      curve_supply: String(input.curveSupplyMicro),
      price: String(price),
      step: String(step),
      max_wallet: String(input.maxWalletMicro),
    },
    gas: 100_000_000_000_000n,
    deposit: BigInt(config.marketInitialReserveYocto),
    waitUntil: "FINAL",
  });
}

export async function setOnChainMarketOwner(tokenId: string, newOwner: string): Promise<void> {
  const file = path.join(
    config.nearCredentialsDir,
    config.nearNetwork,
    `${config.nearOracleAccountId}.json`,
  );
  let privateKey = config.nearOraclePrivateKey;
  if (!privateKey) {
    privateKey = (JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as {
      private_key: string;
    }).private_key;
  }
  const connection = rpcTarget();
  const provider = new JsonRpcProvider(
    { url: connection.url, headers: connection.headers },
    { retries: 3 },
  );
  const account = new Account(
    config.nearOracleAccountId,
    provider,
    KeyPairSigner.fromSecretKey(privateKey as `ed25519:${string}`),
  );
  await account.callFunction({
    contractId: config.nearMarketContractId,
    methodName: "set_market_owner",
    args: { token_id: tokenId, new_owner: newOwner },
    gas: 50_000_000_000_000n,
    deposit: 0n,
    waitUntil: "FINAL",
  });
}

interface ChainSnapshot {
  markets: OnChainMarket[];
  trades: OnChainTrade[];
  nearUsd: number;
  nearUsdSource: string;
  nearUsdUpdatedAt: number;
  fetchedAt: number;
}

interface FeeSnapshot {
  devFees: Record<string, string>;
  staked: Record<string, string>;
  fetchedAt: number;
}

let snapshot: ChainSnapshot | null = null;
let snapshotInflight: Promise<ChainSnapshot> | null = null;
let feeSnapshot: FeeSnapshot | null = null;
let feeInflight: Promise<FeeSnapshot> | null = null;

async function fetchAllTrades(): Promise<OnChainTrade[]> {
  const all: OnChainTrade[] = [];
  const pageSize = 500;
  for (let from = 0; from < 5000; from += pageSize) {
    const page = await view<Array<Record<string, unknown>>>("get_all_trades", {
      from_index: from,
      limit: pageSize,
    });
    const rows = (page ?? []).map(normalizeTrade);
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

export async function getChainSnapshot(force = false): Promise<ChainSnapshot> {
  if (!force && snapshot && Date.now() - snapshot.fetchedAt < 15_000) return snapshot;
  if (!snapshotInflight) {
    snapshotInflight = (async () => {
      try {
        const [marketsRaw, trades, quote] = await Promise.all([
          view<Array<Record<string, unknown>>>("get_markets", { from_index: 0, limit: 200 }),
          fetchAllTrades(),
          getNearUsd(),
        ]);
        const next: ChainSnapshot = {
          markets: (marketsRaw ?? []).map(normalizeMarket),
          trades,
          nearUsd: quote.usd,
          nearUsdSource: quote.source,
          nearUsdUpdatedAt: quote.updatedAt,
          fetchedAt: Date.now(),
        };
        snapshot = next;
        return next;
      } catch (error) {
        if (snapshot) return snapshot;
        return {
          markets: [],
          trades: [],
          nearUsd: 0,
          nearUsdSource: "unavailable",
          nearUsdUpdatedAt: Date.now(),
          fetchedAt: Date.now(),
        };
      }
    })().finally(() => {
      snapshotInflight = null;
    });
  }
  return snapshotInflight;
}

export async function getFeeSnapshot(force = false): Promise<FeeSnapshot> {
  if (!force && feeSnapshot && Date.now() - feeSnapshot.fetchedAt < 60_000) return feeSnapshot;
  if (!feeInflight) {
    feeInflight = (async () => {
      const chain = await getChainSnapshot();
      const devFees: Record<string, string> = {};
      await Promise.all(
        chain.markets.map(async (market) => {
          const dev = await view<unknown>("get_dev_fees", { token_id: market.tokenId }).catch(() => "0");
          devFees[market.tokenId] = stringify(dev);
        }),
      );
      const next = { devFees, staked: {} as Record<string, string>, fetchedAt: Date.now() };
      feeSnapshot = next;
      return next;
    })()
      .catch(() => feeSnapshot ?? { devFees: {}, staked: {}, fetchedAt: Date.now() })
      .finally(() => {
        feeInflight = null;
      });
  }
  return feeInflight;
}

export function tradesForToken(trades: OnChainTrade[], tokenId: string): OnChainTrade[] {
  return sortTradesAsc(trades.filter((trade) => trade.tokenId === tokenId));
}

export async function getOnChainMarket(
  tokenId: string,
  accountId?: string | null,
): Promise<OnChainMarketDetail> {
  const base: OnChainMarketDetail = {
    contractId: config.nearMarketContractId,
    network: config.nearNetwork,
    nearUsd: 0,
    nearUsdSource: "unavailable",
    nearUsdUpdatedAt: 0,
    market: null,
    stats: null,
    balance: "0",
    cost: "0",
    stake: "0",
    pendingRewards: "0",
    totalStaked: "0",
    trades: [],
    holders: [],
    bounties: [],
    chart: [],
  };
  try {
    const [snapshot, marketRaw] = await Promise.all([
      getChainSnapshot(Boolean(accountId)),
      view<Record<string, unknown> | null>("get_market", { token_id: tokenId }),
    ]);
    base.nearUsd = snapshot.nearUsd;
    base.nearUsdSource = snapshot.nearUsdSource;
    base.nearUsdUpdatedAt = snapshot.nearUsdUpdatedAt;
    if (!marketRaw) return base;
    const market = normalizeMarket(marketRaw);
    const tradesAsc = tradesForToken(snapshot.trades, tokenId);
    base.market = market;
    base.stats = deriveMarketStats(market, tradesAsc, snapshot.nearUsd);
    base.trades = [...tradesAsc].reverse();
    base.holders = holdersFromTrades(tradesAsc);
    base.chart = buildChart(market, tradesAsc);
    const [totalStaked, bounties] = await Promise.all([
      view<unknown>("get_total_staked", { token_id: tokenId }).catch(() => "0"),
      view<Array<Record<string, unknown>>>("get_bounties", { token_id: tokenId, limit: 50 }).catch(() => []),
    ]);
    base.totalStaked = stringify(totalStaked);
    base.bounties = (bounties ?? []).map(normalizeBounty);
    if (accountId) {
      const [balance, cost, stake, pendingRewards] = await Promise.all([
        view<unknown>("get_balance", { token_id: tokenId, account_id: accountId }),
        view<unknown>("get_cost", { token_id: tokenId, account_id: accountId }),
        view<unknown>("get_stake", { token_id: tokenId, account_id: accountId }),
        view<unknown>("get_pending_rewards", { token_id: tokenId, account_id: accountId }),
      ]);
      base.balance = stringify(balance);
      base.cost = stringify(cost);
      base.stake = stringify(stake);
      base.pendingRewards = stringify(pendingRewards);
    }
    return base;
  } catch {
    return base;
  }
}

export async function getAccountNearBalance(accountId: string): Promise<string> {
  for (const target of rpcTargets()) {
    try {
      const response = await fetch(target.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...target.headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "query",
          params: { request_type: "view_account", finality: "final", account_id: accountId },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const payload = (await response.json()) as { result?: { amount?: string } };
      if (payload.result?.amount) return payload.result.amount;
    } catch {
    }
  }
  return "0";
}

export { YOCTO, MICRO, BPS, timestampMs, holdersFromTrades, sortTradesAsc };
