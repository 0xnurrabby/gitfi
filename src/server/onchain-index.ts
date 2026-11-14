import { db } from "./db.js";
import { config } from "./config.js";
import type { UserRow } from "./auth.js";
import type {
  ActivityItem,
  ExploreResponse,
  FeeCredit,
  HomeResponse,
  LeaderboardEntry,
  PortfolioHolding,
  PortfolioResponse,
  PortfolioStake,
  TokenSummary,
  Trade,
} from "../shared/types.js";
import { repoSummary, type RepoRow, type TokenRow } from "./tokens.js";
import {
  deriveMarketStats,
  getAccountNearBalance,
  getChainSnapshot,
  getFeeSnapshot,
  holdersFromTrades,
  timestampMs,
  tradesForToken,
  YOCTO,
  type OnChainMarket,
  type OnChainMarketStats,
  type OnChainTrade,
} from "./onchain.js";
import { yoctoToUsdMicro } from "./near-price.js";

interface TokenWithRepo {
  token: TokenRow;
  repo: RepoRow;
}

function loadTokenRows(): Map<string, TokenWithRepo> {
  const tokens = db.prepare("SELECT * FROM tokens").all() as unknown as TokenRow[];
  const map = new Map<string, TokenWithRepo>();
  for (const token of tokens) {
    const repo = db.prepare("SELECT * FROM repos WHERE id = ?").get(token.repo_id) as
      | RepoRow
      | undefined;
    if (repo) map.set(token.id, { token, repo });
  }
  return map;
}

function usdMicroFromYocto(yocto: bigint, nearUsd: number): number {
  if (nearUsd <= 0) return 0;
  return yoctoToUsdMicro(yocto, nearUsd);
}

function summaryFor(
  entry: TokenWithRepo,
  market: OnChainMarket,
  stats: OnChainMarketStats,
  nearUsd: number,
  opts: { rank?: number; staked?: string; devFees?: string; isKing?: boolean } = {},
): TokenSummary {
  const { token, repo } = entry;
  return {
    id: token.id,
    slug: token.slug,
    name: token.name,
    ticker: token.ticker,
    description: token.description,
    logoUrl: token.logo_url,
    website: token.website,
    twitter: token.twitter,
    status: (market.status === "graduated" ? "graduated" : "bonding") as TokenSummary["status"],
    verification: (repo.sync_state !== "ok" ? "hidden" : token.verification) as TokenSummary["verification"],
    tier: token.tier as TokenSummary["tier"],
    ownerAddress: market.owner ?? token.owner_wallet,
    repo: repoSummary(repo),
    priceMicro: stats.priceUsdMicro,
    marketCapMicro: stats.marketCapUsdMicro,
    graduationTargetMicro: stats.marketCapUsdMicro,
    progressBps: stats.progressBps,
    volume24hMicro: stats.volume24hUsdMicro,
    volumeTotalMicro: stats.volumeTotalUsdMicro,
    holderCount: stats.holderCount,
    totalStakedMicro: Number(BigInt(opts.staked ?? "0")),
    unclaimedDevVaultMicro: usdMicroFromYocto(BigInt(opts.devFees ?? "0"), nearUsd),
    burnedMicro: 0,
    launchAt: new Date(timestampMs(market.createdAt)).toISOString(),
    graduatedAt: market.status === "graduated" ? new Date(timestampMs(market.createdAt)).toISOString() : null,
    createdAt: new Date(timestampMs(market.createdAt)).toISOString(),
    change24hBps: stats.change24hBps,
    sparkline: stats.sparkline,
    royaltyFrozen: false,
    rank: opts.rank,
    isKing: opts.isKing,
  };
}

export async function getAllOnChainTokens(): Promise<TokenSummary[]> {
  const [snapshot, fees] = await Promise.all([getChainSnapshot(), getFeeSnapshot()]);
  const rows = loadTokenRows();
  const result: TokenSummary[] = [];
  for (const market of snapshot.markets) {
    const entry = rows.get(market.tokenId);
    if (!entry) continue;
    const stats = deriveMarketStats(
      market,
      tradesForToken(snapshot.trades, market.tokenId),
      snapshot.nearUsd,
    );
    result.push(
      summaryFor(entry, market, stats, snapshot.nearUsd, {
        staked: fees.staked[market.tokenId],
        devFees: fees.devFees[market.tokenId],
      }),
    );
  }
  // Attach USD value to unclaimed dev fees with the live NEAR quote.
  for (const token of result) {
    const market = snapshot.markets.find((item) => item.tokenId === token.id);
    if (!market) continue;
    token.unclaimedDevVaultMicro = usdMicroFromYocto(
      BigInt(fees.devFees[market.tokenId] ?? "0"),
      snapshot.nearUsd,
    );
  }
  result.sort((a, b) => b.volume24hMicro - a.volume24hMicro || b.marketCapMicro - a.marketCapMicro);
  result.forEach((token, index) => {
    token.rank = index + 1;
  });
  return result;
}

function globalHolderCount(trades: OnChainTrade[]): number {
  const holders = new Set<string>();
  const positions = new Map<string, bigint>();
  for (const trade of trades) {
    const key = `${trade.accountId}|${trade.tokenId}`;
    const current = positions.get(key) ?? 0n;
    const next =
      trade.side === "buy"
        ? current + BigInt(trade.tokenAmount || "0")
        : current - BigInt(trade.tokenAmount || "0");
    positions.set(key, next);
  }
  for (const [key, amount] of positions) {
    if (amount > 0n) holders.add(key.split("|")[0]!);
  }
  return holders.size;
}

function activityFromTrades(
  trades: OnChainTrade[],
  rows: Map<string, TokenWithRepo>,
  limit: number,
): ActivityItem[] {
  return [...trades]
    .sort((a, b) => Number(BigInt(b.timestamp) - BigInt(a.timestamp)))
    .slice(0, limit)
    .map((trade) => {
      const entry = rows.get(trade.tokenId);
      const near = Number(BigInt(trade.nearAmount || "0")) / Number(YOCTO);
      const tokens = Number(BigInt(trade.tokenAmount || "0")) / 1_000_000;
      const action = trade.side === "buy" ? "bought" : "sold";
      return {
        id: `chain-trade-${trade.id}`,
        type: "trade" as const,
        tokenId: trade.tokenId,
        tokenSlug: entry?.token.slug ?? null,
        tokenTicker: entry?.token.ticker ?? null,
        logoUrl: entry?.token.logo_url ?? null,
        actor: trade.accountId,
        message: `${trade.accountId} ${action} ${tokens.toLocaleString("en-US", {
          maximumFractionDigits: 2,
        })} $${entry?.token.ticker ?? "tokens"} for ${near.toFixed(4)} NEAR`,
        metadata: {
          side: trade.side,
          near: trade.nearAmount,
          tokens: trade.tokenAmount,
          txId: trade.id,
        },
        createdAt: new Date(timestampMs(trade.timestamp)).toISOString(),
      };
    });
}

interface UserPosition {
  accountId: string;
  tokenId: string;
  tokens: bigint;
  cost: bigint;
  realized: bigint;
}

function replayPositions(trades: OnChainTrade[]): Map<string, UserPosition> {
  const positions = new Map<string, UserPosition>();
  const asc = [...trades].sort((a, b) => {
    const diff = BigInt(a.timestamp) - BigInt(b.timestamp);
    return diff < 0n ? -1 : diff > 0n ? 1 : Number(BigInt(a.id) - BigInt(b.id));
  });
  for (const trade of asc) {
    const key = `${trade.accountId}|${trade.tokenId}`;
    const position =
      positions.get(key) ??
      ({ accountId: trade.accountId, tokenId: trade.tokenId, tokens: 0n, cost: 0n, realized: 0n } as UserPosition);
    const tokens = BigInt(trade.tokenAmount || "0");
    const near = BigInt(trade.nearAmount || "0");
    if (trade.side === "buy") {
      position.tokens += tokens;
      position.cost += near;
    } else {
      const sold = position.tokens > 0n ? (position.cost * tokens) / position.tokens : 0n;
      position.cost -= sold;
      position.tokens -= tokens;
      position.realized += near - sold;
    }
    if (position.tokens < 0n) position.tokens = 0n;
    if (position.cost < 0n) position.cost = 0n;
    positions.set(key, position);
  }
  return positions;
}

export async function leaderboardOnChain(limit = 24): Promise<LeaderboardEntry[]> {
  const snapshot = await getChainSnapshot();
  const rows = loadTokenRows();
  const positions = replayPositions(snapshot.trades);
  const prices = new Map<string, bigint>();
  for (const market of snapshot.markets) prices.set(market.tokenId, BigInt(market.price || "0"));
  const users = new Map<string, { volume: bigint; trades: number; pnl: bigint }>();
  for (const trade of snapshot.trades) {
    const current = users.get(trade.accountId) ?? { volume: 0n, trades: 0, pnl: 0n };
    current.volume += BigInt(trade.nearAmount || "0");
    current.trades += 1;
    users.set(trade.accountId, current);
  }
  for (const position of positions.values()) {
    const price = prices.get(position.tokenId) ?? 0n;
    const value = position.tokens * price;
    const record = users.get(position.accountId);
    if (record) record.pnl += position.realized + value - position.cost;
  }
  const displayNames = new Map<string, string>();
  for (const row of db.prepare("SELECT address, display_name FROM users").all() as Array<{
    address: string;
    display_name: string;
  }>) {
    displayNames.set(row.address, row.display_name);
  }
  return [...users.entries()]
    .sort((a, b) => (b[1].volume > a[1].volume ? 1 : b[1].volume < a[1].volume ? -1 : 0))
    .slice(0, limit)
    .map(([address, stats], index) => ({
      rank: index + 1,
      address,
      displayName: displayNames.get(address) ?? `${address.slice(0, 6)}…${address.slice(-4)}`,
      xp: stats.trades * 10,
      pnlMicro: usdMicroFromYocto(stats.pnl, snapshot.nearUsd),
      trades: stats.trades,
      avatarUrl: null,
    }));
}

export async function homeOnChain(): Promise<HomeResponse> {
  const [snapshot, fees] = await Promise.all([getChainSnapshot(), getFeeSnapshot()]);
  const rows = loadTokenRows();
  const all = new Map<string, TokenSummary>();
  for (const market of snapshot.markets) {
    const entry = rows.get(market.tokenId);
    if (!entry) continue;
    const stats = deriveMarketStats(
      market,
      tradesForToken(snapshot.trades, market.tokenId),
      snapshot.nearUsd,
    );
    all.set(
      market.tokenId,
      summaryFor(entry, market, stats, snapshot.nearUsd, {
        staked: fees.staked[market.tokenId],
        devFees: fees.devFees[market.tokenId],
      }),
    );
  }
  const tokens = [...all.values()];
  const volumeRanked = [...tokens].sort(
    (a, b) => b.volume24hMicro - a.volume24hMicro || b.marketCapMicro - a.marketCapMicro,
  );
  const featured = [...tokens]
    .sort(
      (a, b) =>
        b.volume24hMicro * 3 + b.repo.stars * 1000 - (a.volume24hMicro * 3 + a.repo.stars * 1000),
    )
    .slice(0, 6);
  const fresh = [...tokens]
    .filter((token) => token.tier === "seed")
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 4);
  const newLaunches = [...tokens]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);
  const devEarned = snapshot.markets.reduce(
    (sum, market) => sum + BigInt(fees.devFees[market.tokenId] ?? "0"),
    0n,
  );
  const totalCap = tokens.reduce((sum, token) => sum + BigInt(token.marketCapMicro), 0n);
  const totalVolume = tokens.reduce((sum, token) => sum + BigInt(token.volume24hMicro), 0n);
  const stats = {
    totalMarketCapMicro: Number(totalCap),
    volume24hMicro: Number(totalVolume),
    developersEarnedMicro: usdMicroFromYocto(devEarned, snapshot.nearUsd),
    verifiedRepos: (
      db.prepare("SELECT COUNT(*) AS count FROM repo_verifications").get() as { count: number }
    ).count,
    holders: globalHolderCount(snapshot.trades),
    tokensLaunched: snapshot.markets.length,
  };
  return {
    king: null,
    featured,
    fresh,
    trending: volumeRanked.slice(0, 10),
    newLaunches,
    activity: activityFromTrades(snapshot.trades, rows, 18),
    stats,
    topTraders: await leaderboardOnChain(6),
  };
}

export async function exploreOnChain(filters: {
  tier?: string;
  status?: string;
  q?: string;
  community?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}): Promise<ExploreResponse> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.max(1, Math.min(48, filters.pageSize ?? 24));
  let tokens = await getAllOnChainTokens();
  if (filters.tier) tokens = tokens.filter((token) => token.tier === filters.tier);
  if (filters.community) {
    tokens = tokens.filter((token) => token.verification === filters.community);
  }
  if (filters.status === "live") {
    tokens = tokens.filter((token) => token.status !== "frozen");
  } else if (filters.status) {
    tokens = tokens.filter((token) => token.status === filters.status);
  }
  if (filters.q) {
    const q = filters.q.toLowerCase();
    tokens = tokens.filter(
      (token) =>
        token.name.toLowerCase().includes(q) ||
        token.ticker.toLowerCase().includes(q) ||
        token.repo.fullName.toLowerCase().includes(q),
    );
  }
  const sort = filters.sort ?? "trending";
  if (sort === "new") tokens.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  else if (sort === "volume" || sort === "trending") tokens.sort((a, b) => b.volume24hMicro - a.volume24hMicro);
  else if (sort === "stars") tokens.sort((a, b) => b.repo.stars - a.repo.stars);
  else if (sort === "gainers") tokens.sort((a, b) => b.change24hBps - a.change24hBps);
  else if (sort === "progress") tokens.sort((a, b) => b.progressBps - a.progressBps);
  else if (sort === "marketcap") tokens.sort((a, b) => b.marketCapMicro - a.marketCapMicro);
  const total = tokens.length;
  tokens = tokens.slice((page - 1) * pageSize, page * pageSize).map((token, index) => ({
    ...token,
    rank: (page - 1) * pageSize + index + 1,
  }));
  const [snapshot, fees] = await Promise.all([getChainSnapshot(), getFeeSnapshot()]);
  const devEarned = snapshot.markets.reduce(
    (sum, market) => sum + BigInt(fees.devFees[market.tokenId] ?? "0"),
    0n,
  );
  const all = await getAllOnChainTokens();
  return {
    tokens,
    total,
    page,
    pageSize,
    stats: {
      totalMarketCapMicro: all.reduce((sum, token) => sum + token.marketCapMicro, 0),
      volume24hMicro: all.reduce((sum, token) => sum + token.volume24hMicro, 0),
      developersEarnedMicro: usdMicroFromYocto(devEarned, snapshot.nearUsd),
      holders: globalHolderCount(snapshot.trades),
      tokensLaunched: snapshot.markets.length,
    },
  };
}

export async function searchOnChain(q: string, limit = 8): Promise<TokenSummary[]> {
  if (!q.trim()) return [];
  const tokens = await getAllOnChainTokens();
  const query = q.toLowerCase();
  return tokens
    .filter(
      (token) =>
        token.name.toLowerCase().includes(query) ||
        token.ticker.toLowerCase().includes(query) ||
        token.repo.fullName.toLowerCase().includes(query),
    )
    .slice(0, limit);
}

function tradeToView(
  trade: OnChainTrade,
  market: OnChainMarket,
  rows: Map<string, TokenWithRepo>,
  nearUsd: number,
): Trade {
  const entry = rows.get(trade.tokenId);
  const tokens = Number(BigInt(trade.tokenAmount || "0")) / 1_000_000;
  const near = BigInt(trade.nearAmount || "0");
  const priceUsdMicro = Math.round(
    (Number(BigInt(trade.price || "0") * 1_000_000n) / Number(YOCTO)) * nearUsd * 1_000_000,
  );
  return {
    id: trade.id,
    side: trade.side,
    wallet: trade.accountId,
    displayName: trade.accountId,
    tokensMicro: Math.round(tokens * 1_000_000),
    usdMicro: usdMicroFromYocto(near, nearUsd),
    feeMicro: 0,
    priceMicro: priceUsdMicro,
    phase: "curve",
    txHash: `near:${trade.id}`,
    tokenId: trade.tokenId,
    tokenTicker: entry?.token.ticker ?? market.ticker,
    tokenName: entry?.token.name ?? market.repo,
    tokenLogoUrl: entry?.token.logo_url,
    createdAt: new Date(timestampMs(trade.timestamp)).toISOString(),
  };
}

export async function portfolioOnChain(user: UserRow): Promise<
  PortfolioResponse & {
    nearBalanceYocto: string;
    nearUsd: number;
    claimable: Array<{ tokenId: string; ticker: string; devFees: string; rewards: string }>;
    contractId: string;
    network: string;
  }
> {
  const [snapshot, feeStats] = await Promise.all([getChainSnapshot(), getFeeSnapshot()]);
  const rows = loadTokenRows();
  const address = user.address;
  const summaries = new Map<string, TokenSummary>();
  for (const market of snapshot.markets) {
    const entry = rows.get(market.tokenId);
    if (!entry) continue;
    summaries.set(
      market.tokenId,
      summaryFor(entry, market, deriveMarketStats(market, tradesForToken(snapshot.trades, market.tokenId), snapshot.nearUsd), snapshot.nearUsd, {
        staked: feeStats.staked[market.tokenId],
        devFees: feeStats.devFees[market.tokenId],
      }),
    );
  }

  const balances = await Promise.all(
    snapshot.markets.map(async (market) => {
      try {
        const [balance, stake] = await Promise.all([
          viewBalance(market.tokenId, address),
          viewStake(market.tokenId, address),
        ]);
        return { tokenId: market.tokenId, balance, stake };
      } catch {
        return { tokenId: market.tokenId, balance: 0n, stake: 0n };
      }
    }),
  );
  const held = balances.filter((item) => item.balance + item.stake > 0n);
  const details = await Promise.all(
    held.map(async (item) => {
      const [cost, rewards] = await Promise.all([
        viewCost(item.tokenId, address),
        viewRewards(item.tokenId, address),
      ]);
      return { tokenId: item.tokenId, cost, stake: item.stake, rewards };
    }),
  );
  const detailMap = new Map(details.map((item) => [item.tokenId, item]));

  const holdings: PortfolioHolding[] = [];
  const stakes: PortfolioStake[] = [];
  let holdingsValue = 0;
  let totalPnl = 0;
  let dividends = 0n;
  for (const { tokenId, balance } of held) {
    const summary = summaries.get(tokenId);
    const market = snapshot.markets.find((item) => item.tokenId === tokenId);
    const detail = detailMap.get(tokenId);
    if (!summary || !market || !detail) continue;
    const totalTokens = balance + detail.stake;
    const price = BigInt(market.price || "0");
    const valueYocto = totalTokens * price;
    const valueUsd = usdMicroFromYocto(valueYocto, snapshot.nearUsd);
    const costUsd = usdMicroFromYocto(detail.cost, snapshot.nearUsd);
    const pnl = valueUsd - costUsd;
    holdingsValue += valueUsd;
    totalPnl += pnl;
    dividends += detail.rewards;
    holdings.push({
      token: summary,
      amountMicro: Number(totalTokens),
      valueMicro: valueUsd,
      costMicro: costUsd,
      pnlMicro: pnl,
      pnlBps: costUsd > 0 ? Math.round((pnl * 10_000) / costUsd) : 0,
      stakedMicro: Number(detail.stake),
      dividendsClaimableMicro: usdMicroFromYocto(detail.rewards, snapshot.nearUsd),
      vestedMicro: 0,
      vestedUntil: null,
    });
    if (detail.stake > 0n) {
      stakes.push({
        token: summary,
        amountMicro: Number(detail.stake),
        valueMicro: usdMicroFromYocto(detail.stake * price, snapshot.nearUsd),
        lockDays: 0,
        multiplierBps: 10_000,
        unlockAt: new Date().toISOString(),
        pendingMicro: usdMicroFromYocto(detail.rewards, snapshot.nearUsd),
      });
    }
  }
  holdings.sort((a, b) => b.valueMicro - a.valueMicro);
  stakes.sort((a, b) => b.valueMicro - a.valueMicro);

  const claimable = snapshot.markets
    .filter((market) => market.owner === address)
    .map((market) => ({
      tokenId: market.tokenId,
      ticker: market.ticker,
      devFees: feeStats.devFees[market.tokenId] ?? "0",
      rewards: "0",
    }))
    .filter((item) => BigInt(item.devFees) > 0n);
  for (const item of details) {
    if (item.rewards <= 0n) continue;
    const existing = claimable.find((row) => row.tokenId === item.tokenId);
    if (existing) existing.rewards = item.rewards.toString();
    else {
      const market = snapshot.markets.find((row) => row.tokenId === item.tokenId);
      claimable.push({
        tokenId: item.tokenId,
        ticker: market?.ticker ?? "",
        devFees: "0",
        rewards: item.rewards.toString(),
      });
    }
  }

  const developerClaimable = claimable.reduce((sum, item) => sum + BigInt(item.devFees), 0n);
  const dividendsUsd = usdMicroFromYocto(dividends, snapshot.nearUsd);
  const devUsd = usdMicroFromYocto(developerClaimable, snapshot.nearUsd);
  const fees: FeeCredit[] = claimable.map((item) => ({
    id: `chain-fee-${item.tokenId}`,
    tokenId: item.tokenId,
    tokenTicker: item.ticker,
    logoUrl: rows.get(item.tokenId)?.token.logo_url ?? "",
    source: BigInt(item.devFees) > 0n ? "developer" : "dividend",
    amountMicro:
      usdMicroFromYocto(BigInt(item.devFees), snapshot.nearUsd) +
      usdMicroFromYocto(BigInt(item.rewards), snapshot.nearUsd),
    claimedAt: null,
    createdAt: new Date().toISOString(),
  }));

  const userTrades = snapshot.trades
    .filter((trade) => trade.accountId === address)
    .sort((a, b) => Number(BigInt(b.timestamp) - BigInt(a.timestamp)));
  const recentTrades = userTrades.slice(0, 20).map((trade) => {
    const market = snapshot.markets.find((item) => item.tokenId === trade.tokenId)!;
    return tradeToView(trade, market, rows, snapshot.nearUsd);
  });

  const launches = snapshot.markets
    .filter((market) => market.owner === address)
    .map((market) => summaries.get(market.tokenId))
    .filter((token): token is TokenSummary => Boolean(token));

  const nearBalance = await getAccountNearBalance(address);
  const walletUsd = usdMicroFromYocto(BigInt(nearBalance), snapshot.nearUsd);
  const leaderboard = await leaderboardOnChain(100);
  const rank = leaderboard.findIndex((entry) => entry.address === address) + 1;

  return {
    holdings,
    stakes,
    earnings: {
      developerClaimableMicro: devUsd,
      developerPaidMicro: 0,
      dividendsClaimableMicro: dividendsUsd,
      dividendPaidMicro: 0,
      referralMicro: 0,
      referralClaimableMicro: 0,
      totalClaimableMicro: devUsd + dividendsUsd,
    },
    fees,
    referrals: {
      code: user.referral_code,
      link: `/?ref=${user.referral_code}`,
      referredUsers: 0,
      earnedMicro: 0,
      shareBps: 0,
    },
    xp: userTrades.length * 10,
    rank: rank || 0,
    usdMicro: walletUsd,
    pnlMicro: totalPnl,
    developerLaunches: launches,
    recentTrades,
    nearBalanceYocto: nearBalance,
    nearUsd: snapshot.nearUsd,
    claimable,
    contractId: config.nearMarketContractId,
    network: config.nearNetwork,
  };
}

async function viewBalance(tokenId: string, accountId: string): Promise<bigint> {
  const { view } = await import("./onchain.js");
  const value = await view<unknown>("get_balance", { token_id: tokenId, account_id: accountId });
  return BigInt(String(value ?? "0"));
}

async function viewCost(tokenId: string, accountId: string): Promise<bigint> {
  const { view } = await import("./onchain.js");
  const value = await view<unknown>("get_cost", { token_id: tokenId, account_id: accountId });
  return BigInt(String(value ?? "0"));
}

async function viewStake(tokenId: string, accountId: string): Promise<bigint> {
  const { view } = await import("./onchain.js");
  const value = await view<unknown>("get_stake", { token_id: tokenId, account_id: accountId });
  return BigInt(String(value ?? "0"));
}

async function viewRewards(tokenId: string, accountId: string): Promise<bigint> {
  const { view } = await import("./onchain.js");
  const value = await view<unknown>("get_pending_rewards", { token_id: tokenId, account_id: accountId });
  return BigInt(String(value ?? "0"));
}
