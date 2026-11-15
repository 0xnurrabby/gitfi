import { db } from "./db.js";
import type { UserRow } from "./auth.js";
import type { UserProfile } from "../shared/types.js";
import type {
  ActivityItem,
  ChartCandle,
  ChartResponse,
  ExploreResponse,
  FeeCredit,
  HomeResponse,
  LeaderboardEntry,
  PortfolioHolding,
  PortfolioResponse,
  PortfolioStake,
  PricePoint,
  TokenDetail,
  TokenSummary,
  Trade,
} from "../shared/types.js";
import {
  getUserByAddress,
  holderPositions,
  getRepo,
  getTokenById,
  getTokenRow,
  marketCapForToken,
  progressForToken,
  sparklineFor,
  stakeFor,
  tokenDetail,
  tokenSummary,
  userDividendPending,
  type RepoRow,
  type TokenRow,
} from "./tokens.js";
import { getKing } from "./king.js";

interface TokenWithRepo {
  token: TokenRow;
  repo: RepoRow;
}

export function allTokenRows(limit = 500): TokenWithRepo[] {
  const tokens = db
    .prepare("SELECT * FROM tokens ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as TokenRow[];
  const result: TokenWithRepo[] = [];
  for (const token of tokens) {
    const repo = getRepo(token.repo_id);
    if (repo) result.push({ token, repo });
  }
  return result;
}

export function tokensForIds(ids: string[]): TokenWithRepo[] {
  if (ids.length === 0) return [];
  const result: TokenWithRepo[] = [];
  for (const id of ids) {
    const token = getTokenById(id);
    if (!token) continue;
    const repo = getRepo(token.repo_id);
    if (repo) result.push({ token, repo });
  }
  return result;
}

function findActive(filters: {
  tier?: string;
  status?: string;
  q?: string;
  community?: string;
  limit?: number;
  offset?: number;
  sort?: string;
}): { rows: TokenWithRepo[]; total: number } {
  const where: string[] = ["r.sync_state = 'ok'"];
  const params: Array<string | number> = [];
  if (filters.tier) {
    where.push("t.tier = ?");
    params.push(filters.tier);
  }
  if (filters.status === "live") {
    where.push("t.status IN ('bonding','graduated')");
  } else if (filters.status) {
    where.push("t.status = ?");
    params.push(filters.status);
  }
  if (filters.community === "community") where.push("t.verification = 'community'");
  if (filters.community === "verified") where.push("t.verification = 'verified'");
  if (filters.q) {
    where.push("(lower(t.name) LIKE ? OR lower(t.ticker) LIKE ? OR lower(r.full_name) LIKE ?)");
    const q = `%${filters.q.toLowerCase()}%`;
    params.push(q, q, q);
  }
  const clauses = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM tokens t JOIN repos r ON r.id = t.repo_id ${clauses}`)
      .get(...params) as { count: number }
  ).count;
  let order = "t.volume_24h_micro DESC, r.stars DESC";
  if (filters.sort === "new") order = "t.created_at DESC";
  else if (filters.sort === "volume") order = "t.volume_24h_micro DESC";
  else if (filters.sort === "stars") order = "r.stars DESC";
  else if (filters.sort === "gainers") order = "t.volume_24h_micro DESC";
  else if (filters.sort === "progress") order = "t.sold_micro DESC";
  else if (filters.sort === "marketcap") order = "t.last_price_micro DESC";
  const limit = Math.max(1, Math.min(60, filters.limit ?? 24));
  const offset = Math.max(0, filters.offset ?? 0);
  const tokens = db
    .prepare(
      `SELECT t.* FROM tokens t JOIN repos r ON r.id = t.repo_id ${clauses} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as TokenRow[];
  const rows: TokenWithRepo[] = [];
  for (const token of tokens) {
    const repo = getRepo(token.repo_id);
    if (repo) rows.push({ token, repo });
  }
  return { rows, total };
}

function summarizeGroup(rows: TokenWithRepo[], kings: Set<string>): TokenSummary[] {
  return rows.map(({ token, repo }, index) =>
    tokenSummary(token, repo, { rank: index + 1, isKing: kings.has(token.id) }),
  );
}

export function platformStats(): HomeResponse["stats"] {
  const base = db
    .prepare(
      `SELECT COUNT(*) AS tokens,
        COUNT(DISTINCT t.owner_wallet) AS owners,
        COALESCE(SUM((t.last_price_micro * (t.total_supply_micro - t.burned_micro)) / 1000000),0) AS market_cap,
        COALESCE(SUM(t.volume_24h_micro),0) AS volume_24h
       FROM tokens t JOIN repos r ON r.id = t.repo_id WHERE r.sync_state = 'ok'`,
    )
    .get() as { tokens: number; owners: number; market_cap: number; volume_24h: number };
  const devEarned = (
    db.prepare("SELECT COALESCE(SUM(dev_fee_micro),0) AS amount FROM fee_events").get() as {
      amount: number;
    }
  ).amount;
  const holders = (
    db.prepare("SELECT COUNT(DISTINCT user_id) AS count FROM holdings WHERE amount_micro > 0").get() as {
      count: number;
    }
  ).count;
  const verified = (
    db.prepare("SELECT COUNT(*) AS count FROM repo_verifications").get() as { count: number }
  ).count;
  return {
    totalMarketCapMicro: base.market_cap,
    volume24hMicro: base.volume_24h,
    developersEarnedMicro: devEarned,
    verifiedRepos: verified,
    holders,
    tokensLaunched: base.tokens,
  };
}

function kingsSet(): Set<string> {
  const king = getKing();
  const set = new Set<string>();
  if (king) set.add(king.token.id);
  return set;
}

export function homeData(): HomeResponse {
  const kings = kingsSet();
  const king = getKing();
  const trending = db
    .prepare(
      `SELECT t.* FROM tokens t JOIN repos r ON r.id = t.repo_id
       WHERE r.sync_state = 'ok' AND t.status IN ('bonding','graduated')
       ORDER BY t.volume_24h_micro DESC, r.stars DESC LIMIT 10`,
    )
    .all() as unknown as TokenRow[];
  const fresh = db
    .prepare(
      `SELECT t.* FROM tokens t JOIN repos r ON r.id = t.repo_id
       WHERE r.sync_state = 'ok' AND t.tier = 'seed' AND t.status IN ('bonding','graduated')
       ORDER BY t.sold_micro DESC, t.created_at DESC LIMIT 4`,
    )
    .all() as unknown as TokenRow[];
  const newLaunches = db
    .prepare(
      `SELECT t.* FROM tokens t JOIN repos r ON r.id = t.repo_id
       WHERE r.sync_state = 'ok' AND t.status IN ('bonding','graduated')
       ORDER BY t.created_at DESC LIMIT 5`,
    )
    .all() as unknown as TokenRow[];
  const featured = db
    .prepare(
      `SELECT t.* FROM tokens t JOIN repos r ON r.id = t.repo_id
       WHERE r.sync_state = 'ok' AND t.status IN ('bonding','graduated') AND t.verification = 'verified'
       ORDER BY (t.volume_24h_micro * 3 + r.stars * 1000) DESC LIMIT 6`,
    )
    .all() as unknown as TokenRow[];
  const toRows = (rows: TokenRow[]) =>
    rows
      .map((t) => {
        const repo = getRepo(t.repo_id);
        return repo ? { token: t, repo } : null;
      })
      .filter((row): row is TokenWithRepo => Boolean(row));
  const activity = activityFeed(18);
  const topTraders = leaderboard(6);
  return {
    king,
    featured: summarizeGroup(toRows(featured), kings),
    fresh: summarizeGroup(toRows(fresh), kings),
    trending: summarizeGroup(toRows(trending), kings),
    newLaunches: summarizeGroup(toRows(newLaunches), kings),
    activity,
    stats: platformStats(),
    topTraders,
  };
}

export function exploreData(filters: {
  tier?: string;
  status?: string;
  q?: string;
  community?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}): ExploreResponse {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.max(1, Math.min(48, filters.pageSize ?? 24));
  const { rows, total } = findActive({
    ...filters,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const kings = kingsSet();
  return {
    tokens: summarizeGroup(rows, kings),
    total,
    page,
    pageSize,
    stats: platformStats(),
  };
}

export function searchData(q: string, limit = 6): TokenSummary[] {
  if (!q.trim()) return [];
  const { rows } = findActive({ q, limit, sort: "volume" });
  return summarizeGroup(rows, kingsSet());
}

export function activityFeed(limit = 20, tokenId?: string): ActivityItem[] {
  const rows = db
    .prepare(
      `SELECT a.*, t.ticker, t.slug, t.logo_url, u.display_name
       FROM activities a
       LEFT JOIN tokens t ON t.id = a.token_id
       LEFT JOIN users u ON u.address = a.actor_wallet
       ${tokenId ? "WHERE a.token_id = ?" : ""}
       ORDER BY a.created_at DESC LIMIT ?`,
    )
    .all(...(tokenId ? [tokenId, Math.min(60, limit)] : [Math.min(60, limit)])) as Array<{
    id: string;
    type: string;
    actor_wallet: string | null;
    message: string;
    metadata_json: string;
    created_at: string;
    token_id: string | null;
    ticker: string | null;
    slug: string | null;
    logo_url: string | null;
    display_name: string | null;
  }>;
  return rows.map((row) => {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    return {
      id: row.id,
      type: row.type as ActivityItem["type"],
      tokenId: row.token_id,
      tokenSlug: row.slug,
      tokenTicker: row.ticker,
      logoUrl: row.logo_url,
      actor: row.display_name ?? row.actor_wallet,
      message: row.message,
      metadata: { ...metadata, address: row.actor_wallet },
      createdAt: row.created_at,
    };
  });
}

export function tradeFeed(tokenId: string, limit = 30): Trade[] {
  const rows = db
    .prepare(
      `SELECT tr.*, u.display_name FROM trades tr LEFT JOIN users u ON u.id = tr.user_id
       WHERE tr.token_id = ? ORDER BY tr.created_at DESC LIMIT ?`,
    )
    .all(tokenId, Math.min(100, limit)) as Array<{
    id: string;
    side: string;
    wallet: string;
    display_name: string | null;
    token_micro: number;
    usd_micro: number;
    fee_micro: number;
    price_micro: number;
    phase: string;
    tx_hash: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    side: row.side as "buy" | "sell",
    wallet: row.wallet,
    displayName: row.display_name ?? row.wallet,
    tokensMicro: row.token_micro,
    usdMicro: row.usd_micro,
    feeMicro: row.fee_micro,
    priceMicro: row.price_micro,
    phase: row.phase as "curve" | "dex",
    txHash: row.tx_hash,
    createdAt: row.created_at,
  }));
}

export function userTradeFeed(userId: string, limit = 25): Trade[] {
  const rows = db
    .prepare(
      `SELECT tr.*, u.display_name, t.ticker AS token_ticker, t.name AS token_name, t.logo_url AS token_logo
       FROM trades tr
       LEFT JOIN users u ON u.id = tr.user_id
       JOIN tokens t ON t.id = tr.token_id
       WHERE tr.user_id = ? ORDER BY tr.created_at DESC LIMIT ?`,
    )
    .all(userId, Math.min(60, limit)) as Array<{
    id: string;
    side: string;
    wallet: string;
    display_name: string | null;
    token_micro: number;
    usd_micro: number;
    fee_micro: number;
    price_micro: number;
    phase: string;
    tx_hash: string;
    created_at: string;
    token_id: string;
    token_ticker: string;
    token_name: string;
    token_logo: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    side: row.side as "buy" | "sell",
    wallet: row.wallet,
    displayName: row.display_name ?? row.wallet,
    tokensMicro: row.token_micro,
    usdMicro: row.usd_micro,
    feeMicro: row.fee_micro,
    priceMicro: row.price_micro,
    phase: row.phase as "curve" | "dex",
    txHash: row.tx_hash,
    tokenId: row.token_id,
    tokenTicker: row.token_ticker,
    tokenName: row.token_name,
    tokenLogoUrl: row.token_logo,
    createdAt: row.created_at,
  }));
}

export function leaderboard(limit = 20): LeaderboardEntry[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.address, u.display_name, u.xp, u.avatar_url,
        (u.realized_pnl_micro +
          COALESCE((SELECT SUM((h.amount_micro * t.last_price_micro / 1000000) - h.cost_micro)
            FROM holdings h JOIN tokens t ON t.id = h.token_id WHERE h.user_id = u.id),0)) AS pnl,
        COALESCE((SELECT COUNT(*) FROM trades tr WHERE tr.user_id = u.id),0) AS trades
       FROM users u ORDER BY u.xp DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    address: string;
    display_name: string;
    xp: number;
    avatar_url: string | null;
    pnl: number;
    trades: number;
  }>;
  return rows.map((row, index) => ({
    rank: index + 1,
    address: row.address,
    displayName: row.display_name,
    xp: row.xp,
    pnlMicro: Math.round(row.pnl),
    trades: row.trades,
    avatarUrl: row.avatar_url,
  }));
}

export function chartData(
  tokenId: string,
  range: "1H" | "24H" | "7D" | "30D" | "ALL" = "24H",
): ChartResponse {
  const token = getTokenById(tokenId);
  const rangeMs: Record<string, number | null> = {
    "1H": 3_600_000,
    "24H": 86_400_000,
    "7D": 7 * 86_400_000,
    "30D": 30 * 86_400_000,
    ALL: null,
  };
  const bucketMs: Record<string, number> = {
    "1H": 60_000,
    "24H": 30 * 60_000,
    "7D": 3_600_000,
    "30D": 4 * 3_600_000,
    ALL: 86_400_000,
  };
  const baseInterval: Record<string, string> = {
    "1H": "1m",
    "24H": "30m",
    "7D": "1h",
    "30D": "4h",
    ALL: "1d",
  };
  let interval = baseInterval[range] ?? "5m";
  const now = Date.now();
  const windowMs = rangeMs[range]!;
  const since = windowMs ? now - windowMs : 0;
  const rows = db
    .prepare(
      `SELECT time, price_micro, volume_micro, type, label FROM price_points
       WHERE token_id = ? AND time >= ? AND type IN ('trade','graduation','launch')
       ORDER BY time ASC`,
    )
    .all(tokenId, since) as Array<{
    time: number;
    price_micro: number;
    volume_micro: number;
    type: string;
    label: string | null;
  }>;
  const buckets = new Map<number, ChartCandle>();
  let bucketWidth = windowMs ? bucketMs[range]! : rangeMs.ALL ? 86_400_000 : bucketMs[range]!;
  if (rows.length > 0 && rows.length <= 80) {
    bucketWidth = 1;
    interval = "1m";
  } else if (rows.length > 1) {
    const span = rows[rows.length - 1]!.time - rows[0]!.time;
    const targetPoints = range === "1H" ? 60 : range === "24H" ? 80 : 120;
    const dynamic = Math.max(30_000, Math.ceil(span / targetPoints / 30_000) * 30_000);
    if (dynamic < bucketWidth) {
      bucketWidth = dynamic;
      const minutes = bucketWidth / 60_000;
      interval =
        minutes < 60
          ? `${Math.max(1, Math.round(minutes))}m`
          : `${Math.max(1, Math.round(minutes / 60))}h`;
    }
  }
  let fallback = token?.last_price_micro ?? 0;
  const beforeWindow =
    windowMs > 0
      ? (db
          .prepare(
            "SELECT price_micro FROM price_points WHERE token_id = ? AND time < ? AND type IN ('trade','graduation') ORDER BY time DESC LIMIT 1",
          )
          .get(tokenId, since) as { price_micro: number } | undefined)
      : undefined;
  let previousClose = beforeWindow?.price_micro ?? (rows[0]?.price_micro ?? fallback);
  for (const row of rows) {
    const bucket = Math.floor(row.time / bucketWidth) * bucketWidth;
    const timeSeconds = Math.floor(bucket / 1000);
    const existing = buckets.get(bucket);
    const price = row.price_micro;
    fallback = price;
    if (existing) {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
      existing.volumeMicro += row.volume_micro;
    } else {
      buckets.set(bucket, {
        time: timeSeconds,
        open: previousClose,
        high: Math.max(previousClose, price),
        low: Math.min(previousClose, price),
        close: price,
        volumeMicro: row.volume_micro,
      });
    }
    previousClose = price;
  }
  let candles = [...buckets.values()].sort((a, b) => a.time - b.time);
  if (candles.length === 0 && token) {
    const time = Math.floor(now / bucketWidth) * bucketWidth / 1000;
    const p = token.last_price_micro || 0;
    candles = [{ time, open: p, high: p, low: p, close: p, volumeMicro: 0 }];
  }
  const markers = db
    .prepare(
      `SELECT created_at, milestone, stars, burn_micro FROM star_events
       WHERE token_id = ? AND created_at >= ? ORDER BY created_at ASC`,
    )
    .all(tokenId, new Date(since).toISOString()) as Array<{
    created_at: string;
    milestone: number;
    stars: number;
    burn_micro: number;
  }>;
  const events: ChartResponse["events"] = markers.map((m) => ({
    time: Math.floor(new Date(m.created_at).getTime() / 1000),
    label: `★ ${m.milestone.toLocaleString()}`,
    type: "star",
  }));
  const grad = db
    .prepare(
      "SELECT time FROM price_points WHERE token_id = ? AND type = 'graduation' LIMIT 1",
    )
    .get(tokenId) as { time: number } | undefined;
  if (grad) events.push({ time: Math.floor(grad.time / 1000), label: "DEX graduation", type: "graduation" });
  const launch = db
    .prepare("SELECT time FROM price_points WHERE token_id = ? AND type = 'launch' LIMIT 1")
    .get(tokenId) as { time: number } | undefined;
  if (launch) events.push({ time: Math.floor(launch.time / 1000), label: "Launch", type: "launch" });
  events.sort((a, b) => a.time - b.time);
  const points: PricePoint[] = rows.map((row) => ({
    time: Math.floor(row.time / 1000),
    priceMicro: row.price_micro,
    volumeMicro: row.volume_micro,
    type:
      row.type === "graduation"
        ? "graduation"
        : row.type === "launch"
          ? "launch"
          : "trade",
    label: row.label ?? undefined,
  }));
  return { candles, points, events, interval };
}

export function tokenTabData(tokenId: string): {
  trades: Trade[];
  holders: ReturnType<typeof holderPositions>;
  activity: ActivityItem[];
} {
  return {
    trades: tradeFeed(tokenId, 40),
    holders: holderPositions(tokenId, { limit: 60 }),
    activity: activityFeed(30, tokenId),
  };
}

export function portfolioData(user: UserRow): PortfolioResponse {
  const holdingRows = db
    .prepare(
      `SELECT h.*, t.last_price_micro FROM holdings h JOIN tokens t ON t.id = h.token_id
       WHERE h.user_id = ? AND h.amount_micro > 0 ORDER BY h.amount_micro DESC`,
    )
    .all(user.id) as Array<{
    token_id: string;
    amount_micro: number;
    cost_micro: number;
    realized_pnl_micro: number;
    vesting_locked_micro: number;
    vesting_until: string | null;
    last_price_micro: number;
  }>;
  const holdings: PortfolioHolding[] = [];
  let dividendsTotal = 0;
  let unrealized = 0;
  for (const row of holdingRows) {
    const token = getTokenById(row.token_id);
    if (!token) continue;
    const repo = getRepo(token.repo_id);
    if (!repo) continue;
    const summary = tokenSummary(token, repo);
    const value = Math.round((row.amount_micro * token.last_price_micro) / 1_000_000);
    const stake = stakeFor(user.id, token.id);
    const pending = userDividendPending(user.id, token.id);
    dividendsTotal += pending;
    unrealized += value - row.cost_micro;
    const vestingActive =
      row.vesting_until && new Date(row.vesting_until).getTime() > Date.now();
    holdings.push({
      token: summary,
      amountMicro: row.amount_micro,
      valueMicro: value,
      costMicro: row.cost_micro,
      pnlMicro: value - row.cost_micro + row.realized_pnl_micro,
      pnlBps: row.cost_micro > 0 ? Math.round(((value - row.cost_micro) * 10_000) / row.cost_micro) : 0,
      stakedMicro: stake?.amountMicro ?? 0,
      dividendsClaimableMicro: pending,
      vestedMicro: vestingActive ? row.vesting_locked_micro : 0,
      vestedUntil: vestingActive ? row.vesting_until : null,
    });
  }
  const stakeRows = db
    .prepare(
      `SELECT s.*, t.id AS token_id FROM stakes s JOIN tokens t ON t.id = s.token_id WHERE s.user_id = ?`,
    )
    .all(user.id) as Array<{
    token_id: string;
    amount_micro: number;
    lock_days: number;
    multiplier_bps: number;
    unlock_at: string;
    started_at: string;
  }>;
  const stakes: PortfolioStake[] = [];
  for (const row of stakeRows) {
    const token = getTokenById(row.token_id);
    if (!token) continue;
    const repo = getRepo(token.repo_id);
    if (!repo) continue;
    const stake = stakeFor(user.id, token.id);
    stakes.push({
      token: tokenSummary(token, repo),
      amountMicro: row.amount_micro,
      valueMicro: Math.round((row.amount_micro * token.last_price_micro) / 1_000_000),
      lockDays: row.lock_days,
      multiplierBps: row.multiplier_bps,
      unlockAt: row.unlock_at,
      pendingMicro: stake?.pendingDividendsMicro ?? 0,
    });
  }
  const earnings = db
    .prepare(
      `SELECT e.source, e.amount_micro, e.claimed_at, t.royalty_frozen, t.ticker, t.logo_url, e.id, e.token_id, e.created_at
       FROM earnings e JOIN tokens t ON t.id = e.token_id WHERE e.user_id = ?
       ORDER BY e.created_at DESC LIMIT 80`,
    )
    .all(user.id) as Array<{
    source: string;
    amount_micro: number;
    claimed_at: string | null;
    royalty_frozen: number;
    ticker: string;
    logo_url: string;
    id: string;
    token_id: string;
    created_at: string;
  }>;
  let developerClaimable = 0;
  let developerPaid = 0;
  let dividendPaid = 0;
  let referralTotal = 0;
  let referralUnclaimed = 0;
  const feeCredits: FeeCredit[] = [];
  for (const earning of earnings) {
    if (earning.source === "developer") {
      if (!earning.royalty_frozen && !earning.claimed_at) developerClaimable += earning.amount_micro;
      if (earning.claimed_at) developerPaid += earning.amount_micro;
    } else if (earning.source === "referral") {
      referralTotal += earning.amount_micro;
      if (!earning.claimed_at) referralUnclaimed += earning.amount_micro;
    } else if (earning.source === "dividend" && earning.claimed_at) {
      dividendPaid += earning.amount_micro;
    }
    feeCredits.push({
      id: earning.id,
      tokenId: earning.token_id,
      tokenTicker: earning.ticker,
      logoUrl: earning.logo_url,
      source: earning.source as FeeCredit["source"],
      amountMicro: earning.amount_micro,
      claimedAt: earning.claimed_at,
      createdAt: earning.created_at,
    });
  }
  const referralCount = (
    db.prepare("SELECT COUNT(*) AS count FROM users WHERE referrer_id = ?").get(user.id) as {
      count: number;
    }
  ).count;
  const rank = (
    db.prepare("SELECT COUNT(*) AS count FROM users WHERE xp > ?").get(user.xp) as { count: number }
  ).count + 1;
  const launched = db
    .prepare(
      `SELECT t.* FROM tokens t WHERE t.owner_wallet = ? ORDER BY t.created_at DESC LIMIT 20`,
    )
    .all(user.address) as unknown as TokenRow[];
  const developerLaunches = launched
    .map((token) => {
      const repo = getRepo(token.repo_id);
      return repo ? tokenSummary(token, repo) : null;
    })
    .filter((t): t is TokenSummary => Boolean(t));
  return {
    holdings,
    stakes,
    earnings: {
      developerClaimableMicro: developerClaimable,
      developerPaidMicro: developerPaid,
      dividendsClaimableMicro: dividendsTotal,
      dividendPaidMicro: dividendPaid,
      referralMicro: referralTotal,
      referralClaimableMicro: referralUnclaimed,
      totalClaimableMicro: developerClaimable + dividendsTotal + referralUnclaimed,
    },
    fees: feeCredits,
    referrals: {
      code: user.referral_code,
      link: `${configAppUrl()}/?ref=${user.referral_code}`,
      referredUsers: referralCount,
      earnedMicro: referralTotal,
      shareBps: 1_000,
    },
    xp: user.xp,
    rank,
    usdMicro: user.usd_micro,
    pnlMicro: Math.round(unrealized + user.realized_pnl_micro),
    developerLaunches,
    recentTrades: userTradeFeed(user.id, 25),
  };
}

function configAppUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
}

export function tokenDetailById(
  idOrSlug: string,
  viewer: UserRow | null,
): TokenDetail | null {
  const token = getTokenRow(idOrSlug);
  if (!token) return null;
  const repo = getRepo(token.repo_id);
  if (!repo) return null;
  return tokenDetail(token, repo, viewer, { isKing: getKing()?.token.id === token.id });
}

export function getUserProfile(user: UserRow): UserProfile {
  const pnl = db
    .prepare(
      `SELECT COALESCE(SUM(h.amount_micro * t.last_price_micro / 1000000 - h.cost_micro),0) AS pnl
       FROM holdings h JOIN tokens t ON t.id = h.token_id WHERE h.user_id = ?`,
    )
    .get(user.id) as { pnl: number };
  return {
    id: user.id,
    address: user.address,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    xp: user.xp,
    usdMicro: user.usd_micro,
    pnlMicro: Math.round(pnl.pnl + user.realized_pnl_micro),
    referralCode: user.referral_code,
    referredBy: user.referrer_id,
    createdAt: user.created_at,
    isSandbox: Boolean(user.is_sandbox),
  };
}

void marketCapForToken;
void progressForToken;
void sparklineFor;
void getUserByAddress;
void holderPositions;
