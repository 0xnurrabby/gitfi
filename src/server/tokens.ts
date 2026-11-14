import { db } from "./db.js";
import { healthLabel } from "./github.js";
import { latestChainTx } from "./chain.js";
import {
  FEE_BPS,
  DEVELOPER_FEE_BPS,
  GRADUATION_SOLD_MICRO,
  TIERS,
  TOTAL_SUPPLY_MICRO,
  curveLaunchPriceMicro,
  targetPriceMicro,
  toBigInt,
  maxWalletMicro,
} from "../shared/economics.js";
import type {
  HolderPosition,
  RepoSummary,
  StarMilestone,
  StakePosition,
  TokenDetail,
  TokenSummary,
  UserProfile,
} from "../shared/types.js";
import { config } from "./config.js";
import type { UserRow } from "./auth.js";

export interface RepoRow {
  id: string;
  github_id: number | null;
  full_name: string;
  full_name_lc: string;
  owner: string;
  name: string;
  description: string | null;
  homepage: string | null;
  stars: number;
  forks: number;
  watchers: number;
  open_issues: number;
  language: string | null;
  topics_json: string;
  license: string | null;
  default_branch: string;
  github_created_at: string | null;
  pushed_at: string | null;
  commit_count: number;
  last_commit_at: string | null;
  size_kb: number;
  is_fork: number;
  is_private: number;
  is_archived: number;
  health_score: number;
  star_velocity_1h: number;
  star_velocity_24h: number;
  sync_state: string;
  last_synced_at: string | null;
  readme_md: string | null;
  readme_sha: string | null;
  readme_fetched_at: string | null;
  summary_json: string;
  summary_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TokenRow {
  id: string;
  repo_id: string;
  slug: string;
  name: string;
  ticker: string;
  description: string | null;
  logo_url: string;
  logo_ipfs_url: string | null;
  metadata_json: string;
  website: string | null;
  twitter: string | null;
  owner_wallet: string | null;
  creator_wallet: string;
  verification: string;
  status: string;
  tier: string;
  target_market_cap_micro: number;
  total_supply_micro: number;
  curve_supply_micro: number;
  sold_micro: number;
  reserve_micro: number;
  pool_quote_micro: number;
  pool_token_micro: number;
  burned_micro: number;
  milestone_reserve_micro: number;
  last_price_micro: number;
  volume_24h_micro: number;
  volume_total_micro: number;
  holder_count: number;
  unclaimed_dev_vault_micro: number;
  royalty_frozen: number;
  vip_threshold_micro: number;
  dividend_acc_scaled: string;
  total_staked_micro: number;
  pending_yield_micro: number;
  launch_at: string | null;
  launched_at: string | null;
  graduated_at: string | null;
  created_at: string;
  updated_at: string;
}

export function repoSummary(repo: RepoRow): RepoSummary {
  const verified = Boolean(
    db.prepare("SELECT 1 FROM repo_verifications WHERE repo_id = ?").get(repo.id),
  );
  return {
    id: repo.id,
    fullName: repo.full_name,
    owner: repo.owner,
    name: repo.name,
    description: repo.description,
    stars: repo.stars,
    forks: repo.forks,
    openIssues: repo.open_issues,
    language: repo.language,
    topics: safeJsonArray(repo.topics_json),
    license: repo.license,
    createdAtGithub: repo.github_created_at,
    pushedAt: repo.pushed_at,
    commitCount: repo.commit_count,
    lastCommitAt: repo.last_commit_at,
    starVelocity1h: repo.star_velocity_1h,
    starVelocity24h: repo.star_velocity_24h,
    healthScore: repo.health_score,
    health: healthLabel(repo.health_score) as RepoSummary["health"],
    syncState: (repo.sync_state as RepoSummary["syncState"]) ?? "ok",
    lastSyncedAt: repo.last_synced_at,
    verifiedReadme: verified,
  };
}

export function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function activateDueLaunches(): void {
  db.prepare(
    "UPDATE tokens SET status = 'bonding', launched_at = COALESCE(launched_at, ?), updated_at = ? WHERE status = 'prelaunch' AND launch_at <= ?",
  ).run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
}

export function getTokenRow(idOrSlug: string): TokenRow | null {
  return (
    (db.prepare("SELECT * FROM tokens WHERE id = ? OR slug = ?").get(idOrSlug, idOrSlug) as
      | TokenRow
      | undefined) ?? null
  );
}

export function getTokenById(id: string): TokenRow | null {
  return (db.prepare("SELECT * FROM tokens WHERE id = ?").get(id) as TokenRow | undefined) ?? null;
}

export function getRepo(repoId: string): RepoRow | null {
  return (db.prepare("SELECT * FROM repos WHERE id = ?").get(repoId) as RepoRow | undefined) ?? null;
}

export function getUserByAddress(address: string): UserRow | null {
  return (
    (db.prepare("SELECT * FROM users WHERE address = ?").get(address) as UserRow | undefined) ??
    null
  );
}

export function progressForToken(token: TokenRow): number {
  if (token.status === "graduated") return 10_000;
  return Math.max(
    0,
    Math.min(10_000, Math.floor((token.sold_micro * 10_000) / GRADUATION_SOLD_MICRO)),
  );
}

export function marketCapForToken(token: TokenRow): number {
  return Math.round(
    (token.last_price_micro * (token.total_supply_micro - token.burned_micro)) / 1_000_000,
  );
}

export function firstPricePointAtOrBefore(tokenId: string, time: number): number | null {
  const row = db
    .prepare(
      "SELECT price_micro FROM price_points WHERE token_id = ? AND time <= ? ORDER BY time DESC LIMIT 1",
    )
    .get(tokenId, time) as { price_micro: number } | undefined;
  if (row) return row.price_micro;
  const first = db
    .prepare(
      "SELECT price_micro FROM price_points WHERE token_id = ? ORDER BY time ASC LIMIT 1",
    )
    .get(tokenId) as { price_micro: number } | undefined;
  return first?.price_micro ?? null;
}

export function sparklineFor(tokenId: string, points = 24): number[] {
  const since = Date.now() - 24 * 3600 * 1000;
  let rows = db
    .prepare(
      "SELECT price_micro FROM price_points WHERE token_id = ? AND time >= ? ORDER BY time ASC",
    )
    .all(tokenId, since) as Array<{ price_micro: number }>;
  if (rows.length < 4) {
    rows = db
      .prepare(
        "SELECT price_micro FROM price_points WHERE token_id = ? AND time >= ? ORDER BY time ASC",
      )
      .all(tokenId, Date.now() - 7 * 24 * 3600 * 1000) as Array<{ price_micro: number }>;
  }
  if (rows.length === 0) {
    const any = db
      .prepare("SELECT price_micro FROM price_points WHERE token_id = ? ORDER BY time ASC LIMIT 1")
      .all(tokenId) as Array<{ price_micro: number }>;
    return any.map((r) => r.price_micro);
  }
  if (rows.length <= points) return rows.map((row) => row.price_micro);
  const stride = rows.length / points;
  const sampled: number[] = [];
  for (let i = 0; i < points; i += 1) {
    const row = rows[Math.min(rows.length - 1, Math.floor(i * stride))]!;
    sampled.push(row.price_micro);
  }
  return sampled;
}

export function tokenSummary(
  token: TokenRow,
  repo: RepoRow,
  opts: { isKing?: boolean; rank?: number; sparkline?: number[]; change24hBps?: number } = {},
): TokenSummary {
  const price = token.last_price_micro;
  let change = opts.change24hBps;
  if (change === undefined) {
    const before = firstPricePointAtOrBefore(token.id, Date.now() - 24 * 3600 * 1000);
    change = before && before > 0 ? Math.round(((price - before) * 10_000) / before) : 0;
  }
  return {
    id: token.id,
    slug: token.slug,
    name: token.name,
    ticker: token.ticker,
    description: token.description,
    logoUrl: token.logo_url,
    website: token.website,
    twitter: token.twitter,
    status: token.status as TokenSummary["status"],
    verification: (repo.sync_state !== "ok"
      ? "hidden"
      : token.verification) as TokenSummary["verification"],
    tier: token.tier as TokenSummary["tier"],
    ownerAddress: token.owner_wallet,
    repo: repoSummary(repo),
    priceMicro: price,
    marketCapMicro: marketCapForToken(token),
    graduationTargetMicro: token.target_market_cap_micro,
    progressBps: progressForToken(token),
    volume24hMicro: token.volume_24h_micro,
    volumeTotalMicro: token.volume_total_micro,
    holderCount: token.holder_count,
    totalStakedMicro: token.total_staked_micro,
    unclaimedDevVaultMicro: token.unclaimed_dev_vault_micro,
    burnedMicro: token.burned_micro,
    launchAt: token.launch_at,
    graduatedAt: token.graduated_at,
    createdAt: token.created_at,
    change24hBps: change,
    sparkline: opts.sparkline ?? sparklineFor(token.id),
    royaltyFrozen: Boolean(token.royalty_frozen),
    isKing: opts.isKing,
    rank: opts.rank,
  };
}

export function loadSummaries(
  tokens: Array<{ token: TokenRow; repo: RepoRow }>,
  opts: { kings?: Set<string> } = {},
): TokenSummary[] {
  return tokens.map(({ token, repo }, index) =>
    tokenSummary(token, repo, {
      isKing: opts.kings?.has(token.id),
      rank: index + 1,
    }),
  );
}

export function holderPositions(
  tokenId: string,
  opts: { viewerId?: string; limit?: number } = {},
): HolderPosition[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.address, u.display_name, u.xp, h.amount_micro, h.cost_micro, h.vesting_locked_micro,
              h.vesting_until, COALESCE(s.amount_micro, 0) AS staked_micro
       FROM holdings h
       JOIN users u ON u.id = h.user_id
       LEFT JOIN stakes s ON s.user_id = h.user_id AND s.token_id = h.token_id
       WHERE h.token_id = ? AND h.amount_micro > 0
       ORDER BY h.amount_micro DESC
       LIMIT ?`,
    )
    .all(tokenId, opts.limit ?? 100) as Array<{
    id: string;
    address: string;
    display_name: string;
    xp: number;
    amount_micro: number;
    cost_micro: number;
    vesting_locked_micro: number;
    vesting_until: string | null;
    staked_micro: number;
  }>;
  const token = getTokenById(tokenId);
  const total = token?.total_supply_micro ?? 1;
  const price = token?.last_price_micro ?? 0;
  return rows.map((row) => ({
    address: row.address,
    displayName: row.display_name,
    amountMicro: row.amount_micro,
    costMicro: row.cost_micro,
    valueMicro: Math.round((row.amount_micro * price) / 1_000_000),
    shareBps: Math.round((row.amount_micro * 10_000) / total),
    stakedMicro: row.staked_micro,
    xp: row.xp,
    isOwner: token?.owner_wallet === row.address,
    vestedUntil:
      row.vesting_until && new Date(row.vesting_until).getTime() > Date.now()
        ? row.vesting_until
        : null,
    vestedMicro:
      row.vesting_until && new Date(row.vesting_until).getTime() > Date.now()
        ? row.vesting_locked_micro
        : 0,
    isYou: opts.viewerId === row.id,
  }));
}

export function stakeFor(userId: string, tokenId: string): StakePosition | null {
  const stake = db
    .prepare("SELECT * FROM stakes WHERE user_id = ? AND token_id = ?")
    .get(userId, tokenId) as
    | {
        amount_micro: number;
        lock_days: number;
        multiplier_bps: number;
        reward_debt_scaled: string;
        started_at: string;
        unlock_at: string;
      }
    | undefined;
  if (!stake) return null;
  const token = getTokenById(tokenId);
  const pending = pendingStakeDividends(
    toBigInt(stake.amount_micro),
    toBigInt(stake.reward_debt_scaled),
    toBigInt(token?.dividend_acc_scaled ?? "0"),
  );
  return {
    amountMicro: stake.amount_micro,
    lockDays: stake.lock_days,
    multiplierBps: stake.multiplier_bps,
    unlockAt: stake.unlock_at,
    pendingDividendsMicro: Number(pending),
    stakedAt: stake.started_at,
  };
}

export function pendingStakeDividends(
  amountMicro: bigint,
  debtScaled: bigint,
  accScaled: bigint,
): bigint {
  if (accScaled <= debtScaled || amountMicro <= 0n) return 0n;
  return (amountMicro * (accScaled - debtScaled)) / 1_000_000_000_000_000_000n;
}

export function userDividendPending(userId: string, tokenId: string): number {
  const stake = stakeFor(userId, tokenId);
  const earnings = db
    .prepare(
      `SELECT COALESCE(SUM(amount_micro),0) AS amount FROM earnings
       WHERE user_id = ? AND token_id = ? AND source = 'dividend' AND claimed_at IS NULL`,
    )
    .get(userId, tokenId) as { amount: number };
  return (stake?.pendingDividendsMicro ?? 0) + Number(earnings.amount);
}

function starMilestones(tokenId: string): StarMilestone[] {
  return (
    db
      .prepare("SELECT * FROM star_events WHERE token_id = ? ORDER BY stars DESC LIMIT 8")
      .all(tokenId) as Array<{
      id: string;
      stars: number;
      milestone: number;
      burn_micro: number;
      created_at: string;
    }>
  ).map((row) => ({
    id: row.id,
    stars: row.stars,
    milestone: row.milestone,
    burnedMicro: row.burn_micro,
    createdAt: row.created_at,
  }));
}

function nftFor(repoId: string, tokenId: string) {
  const row = db
    .prepare("SELECT * FROM repo_nfts WHERE repo_id = ?")
    .get(repoId) as
    | {
        id: string;
        status: string;
        owner_wallet: string | null;
        tx_hash: string;
        minted_at: string;
      }
    | undefined;
  if (!row) return null;
  const repo = db.prepare("SELECT full_name FROM repos WHERE id = ?").get(repoId) as
    | { full_name: string }
    | undefined;
  const deedMint = repo ? latestChainTx("deed.mint", repo.full_name.toLowerCase()) : null;
  const tokenAnchor = latestChainTx("token.mint", tokenId);
  return {
    id: row.id,
    status: row.status,
    ownerAddress: row.owner_wallet,
    metadataUrl: `/api/nft/${tokenId}/metadata`,
    txHash: row.tx_hash,
    mintedAt: row.minted_at,
    escrowed: row.status === "escrowed",
    chainTxHash: deedMint?.txHash ?? null,
    chainExplorerUrl: deedMint?.explorerUrl ?? null,
    chainStatus: deedMint?.status ?? null,
    anchorTxHash: tokenAnchor?.txHash ?? null,
    anchorExplorerUrl: tokenAnchor?.explorerUrl ?? null,
  };
}

export function tokenDetail(
  token: TokenRow,
  repo: RepoRow,
  viewer?: UserRow | null,
  opts: { isKing?: boolean } = {},
): TokenDetail {
  const summary = tokenSummary(token, repo, { isKing: opts.isKing });
  const holding = viewer
    ? (db
        .prepare("SELECT * FROM holdings WHERE user_id = ? AND token_id = ?")
        .get(viewer.id, token.id) as
        | {
            amount_micro: number;
            cost_micro: number;
            vesting_locked_micro: number;
            vesting_until: string | null;
          }
        | undefined)
    : undefined;
  const stake = viewer ? stakeFor(viewer.id, token.id) : null;
  const developerEarnings = db
    .prepare(
      `SELECT COALESCE(SUM(amount_micro),0) AS amount FROM earnings
       WHERE token_id = ? AND source = 'developer' AND claimed_at IS NULL`,
    )
    .get(token.id) as { amount: number };
  const referralEarnings = viewer
    ? (db
        .prepare(
          `SELECT COALESCE(SUM(amount_micro),0) AS amount FROM earnings
           WHERE user_id = ? AND source = 'referral' AND claimed_at IS NULL`,
        )
        .get(viewer.id) as { amount: number })
    : { amount: 0 };
  const prelaunchSeconds = token.launch_at
    ? Math.max(0, Math.ceil((new Date(token.launch_at).getTime() - Date.now()) / 1000))
    : 0;
  const tierConfig = TIERS[token.tier as keyof typeof TIERS];
  const nft = nftFor(repo.id, token.id);
  const summaryJson = safeJsonArray(repo.summary_json);
  const canTrade =
    (token.status === "bonding" || token.status === "graduated") &&
    prelaunchSeconds === 0;
  const ownedByViewer = viewer && token.owner_wallet === viewer.address;
  const vestingActive =
    holding?.vesting_until && new Date(holding.vesting_until).getTime() > Date.now();

  return {
    ...summary,
    circulation: {
      totalSupplyMicro: token.total_supply_micro,
      curveSupplyMicro: token.curve_supply_micro,
      soldMicro: token.sold_micro,
      burnedMicro: token.burned_micro,
      milestoneReserveMicro: token.milestone_reserve_micro,
      poolQuoteMicro: token.pool_quote_micro,
      poolTokenMicro: token.pool_token_micro,
    },
    curve: {
      launchPriceMicro: Number(curveLaunchPriceMicro(token.tier as "seed" | "rising" | "viral")),
      currentPriceMicro: token.last_price_micro,
      graduationPriceMicro: Number(targetPriceMicro(token.tier as "seed" | "rising" | "viral")),
      maxWalletBps: tierConfig.perWalletCapBps,
      feeBps: opts.isKing ? DEVELOPER_FEE_BPS : FEE_BPS,
      developerFeeBps: DEVELOPER_FEE_BPS,
      yieldShareBps: config.platformYieldShareBps,
      canTrade,
      prelaunchSeconds,
    },
    community: {
      holderCount: token.holder_count,
      vipThresholdMicro: token.vip_threshold_micro,
      chatUnread: 0,
    },
    developer: {
      claimed: Boolean(token.owner_wallet),
      claimableMicro: Number(developerEarnings.amount),
      unclaimedVaultMicro: token.unclaimed_dev_vault_micro,
      frozen: Boolean(token.royalty_frozen),
      vestingDays: tierConfig.vestingDays,
    },
    readme: {
      markdown: repo.readme_md,
      summary: summaryJson,
      summaryGeneratedAt: repo.summary_at,
      readmeUrl: repo.readme_md
        ? `https://github.com/${repo.full_name}#readme`
        : null,
    },
    stars: {
      current: repo.stars,
      velocity1h: repo.star_velocity_1h,
      velocity24h: repo.star_velocity_24h,
      healthScore: repo.health_score,
      milestones: starMilestones(token.id),
    },
    myHolding: holding
      ? {
          address: viewer!.address,
          displayName: viewer!.display_name,
          amountMicro: holding.amount_micro,
          costMicro: holding.cost_micro,
          valueMicro: Math.round((holding.amount_micro * token.last_price_micro) / 1_000_000),
          shareBps: Math.round((holding.amount_micro * 10_000) / token.total_supply_micro),
          stakedMicro: stake?.amountMicro ?? 0,
          xp: viewer!.xp,
          isOwner: Boolean(ownedByViewer),
          vestedUntil: vestingActive ? holding.vesting_until : null,
          vestedMicro: vestingActive ? holding.vesting_locked_micro : 0,
          isYou: true,
        }
      : null,
    myStake: stake,
    myDividendsMicro: viewer ? userDividendPending(viewer.id, token.id) : 0,
    myReferralEarningsMicro: Number(referralEarnings.amount),
    isOwner: Boolean(ownedByViewer),
    nft,
  };
}

export function userPublic(row: UserRow): UserProfile {
  return {
    id: row.id,
    address: row.address,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    xp: row.xp,
    usdMicro: row.usd_micro,
    pnlMicro: row.realized_pnl_micro,
    referralCode: row.referral_code,
    referredBy: row.referrer_id,
    createdAt: row.created_at,
    isSandbox: Boolean(row.is_sandbox),
  };
}

export function maxWalletForToken(token: TokenRow): number {
  return Number(maxWalletMicro(token.tier as "seed" | "rising" | "viral"));
}

export function totalSupply(token: TokenRow): number {
  return token.total_supply_micro || TOTAL_SUPPLY_MICRO;
}
