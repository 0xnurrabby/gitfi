import type { Tier } from "./economics.js";

export type TokenStatus = "prelaunch" | "bonding" | "graduated" | "frozen";
export type VerificationStatus = "verified" | "community" | "hidden";
export type RepoHealth = "healthy" | "watch" | "degraded" | "hidden";

export interface UserProfile {
  id: string;
  address: string;
  displayName: string;
  avatarUrl: string | null;
  xp: number;
  usdMicro: number;
  pnlMicro: number;
  referralCode: string;
  referredBy: string | null;
  createdAt: string;
  isSandbox: boolean;
}

export interface SessionResponse {
  user: UserProfile | null;
  platform: PlatformInfo;
}

export interface PlatformInfo {
  paused: boolean;
  network: string;
  contractId: string;
  oraclePublicKey: string;
  feeBps: number;
  developerFeeBps: number;
  platformYieldShareBps: number;
  teamAddress: string;
  launchFeeYocto: string;
  tradeFeeBps: number;
  creatorFeeBps: number;
  teamFeeBps: number;
  stakerFeeBps: number;
  demoMode: boolean;
  chainEnabled: boolean;
  explorerUrl: string;
  contractUrl: string;
  chainAccountId: string;
}

export interface ChainTxInfo {
  id: string;
  kind: string;
  aggregate: string;
  subjectId: string | null;
  network: string;
  contractId: string;
  method: string;
  txHash: string | null;
  status: "pending" | "submitted" | "confirmed" | "failed" | "skipped";
  error: string | null;
  explorerUrl: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

export interface ChainStatusInfo {
  enabled: boolean;
  ready: boolean;
  network: string;
  rpcUrl: string;
  contractId: string;
  accountId: string;
  explorerUrl: string;
  contractUrl: string;
  reason: string | null;
  balanceNear: string | null;
  paused: boolean | null;
  totalDeeds: number | null;
  oracleMatches: boolean | null;
  txs: ChainTxInfo[];
  anchors: number;
  deeds: number;
  lastAnchorAt: string | null;
}


export interface RepoSummary {
  id: string;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  stars: number;
  forks: number;
  openIssues: number;
  language: string | null;
  topics: string[];
  license: string | null;
  createdAtGithub: string | null;
  pushedAt: string | null;
  commitCount: number;
  lastCommitAt: string | null;
  starVelocity1h: number;
  starVelocity24h: number;
  healthScore: number;
  health: RepoHealth;
  syncState: "ok" | "hidden" | "missing";
  lastSyncedAt: string | null;
  verifiedReadme: boolean;
}

export interface TokenSummary {
  id: string;
  slug: string;
  name: string;
  ticker: string;
  description: string | null;
  logoUrl: string;
  website: string | null;
  twitter: string | null;
  status: TokenStatus;
  verification: VerificationStatus;
  tier: Tier;
  ownerAddress: string | null;
  repo: RepoSummary;
  priceMicro: number;
  marketCapMicro: number;
  graduationTargetMicro: number;
  progressBps: number;
  volume24hMicro: number;
  volumeTotalMicro: number;
  holderCount: number;
  totalStakedMicro: number;
  unclaimedDevVaultMicro: number;
  burnedMicro: number;
  launchAt: string | null;
  graduatedAt: string | null;
  createdAt: string;
  change24hBps: number;
  sparkline: number[];
  royaltyFrozen: boolean;
  isKing?: boolean;
  rank?: number;
}

export interface TokenDetail extends TokenSummary {
  circulation: {
    totalSupplyMicro: number;
    curveSupplyMicro: number;
    soldMicro: number;
    burnedMicro: number;
    milestoneReserveMicro: number;
    poolQuoteMicro: number;
    poolTokenMicro: number;
  };
  curve: {
    launchPriceMicro: number;
    currentPriceMicro: number;
    graduationPriceMicro: number;
    maxWalletBps: number;
    feeBps: number;
    developerFeeBps: number;
    yieldShareBps: number;
    canTrade: boolean;
    prelaunchSeconds: number;
  };
  community: {
    holderCount: number;
    vipThresholdMicro: number;
    chatUnread: number;
  };
  developer: {
    claimed: boolean;
    claimableMicro: number;
    unclaimedVaultMicro: number;
    frozen: boolean;
    vestingDays: number;
  };
  readme: {
    markdown: string | null;
    summary: string[];
    summaryGeneratedAt: string | null;
    readmeUrl: string | null;
  };
  stars: {
    current: number;
    velocity1h: number;
    velocity24h: number;
    healthScore: number;
    milestones: StarMilestone[];
  };
  myHolding: HolderPosition | null;
  myStake: StakePosition | null;
  myDividendsMicro: number;
  myReferralEarningsMicro: number;
  isOwner: boolean;
  nft: {
    id: string;
    status: string;
    ownerAddress: string | null;
    metadataUrl: string;
    txHash: string;
    mintedAt: string;
    escrowed: boolean;
    chainTxHash?: string | null;
    chainExplorerUrl?: string | null;
    chainStatus?: string | null;
    anchorTxHash?: string | null;
    anchorExplorerUrl?: string | null;
  } | null;
}

export interface StarMilestone {
  id: string;
  stars: number;
  milestone: number;
  burnedMicro: number;
  createdAt: string;
}

export interface HolderPosition {
  address: string;
  displayName: string;
  amountMicro: number;
  costMicro: number;
  valueMicro: number;
  shareBps: number;
  stakedMicro: number;
  xp: number;
  isOwner: boolean;
  vestedUntil: string | null;
  vestedMicro: number;
  isYou?: boolean;
}

export interface StakePosition {
  amountMicro: number;
  lockDays: number;
  multiplierBps: number;
  unlockAt: string;
  pendingDividendsMicro: number;
  stakedAt: string;
}

export interface Trade {
  id: string;
  side: "buy" | "sell";
  wallet: string;
  displayName: string;
  tokensMicro: number;
  usdMicro: number;
  feeMicro: number;
  priceMicro: number;
  phase: "curve" | "dex";
  txHash: string;
  tokenId?: string;
  tokenTicker?: string;
  tokenName?: string;
  tokenLogoUrl?: string;
  createdAt: string;
}

export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeMicro: number;
}

export interface PricePoint {
  time: number;
  priceMicro: number;
  volumeMicro: number;
  type: "trade" | "star" | "graduation" | "launch";
  label?: string;
}

export interface ActivityItem {
  id: string;
  type:
    | "trade"
    | "launch"
    | "verify"
    | "claim"
    | "star"
    | "graduation"
    | "stake"
    | "bounty"
    | "dividend"
    | "vote";
  tokenId: string | null;
  tokenSlug: string | null;
  tokenTicker?: string | null;
  logoUrl?: string | null;
  actor: string | null;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface QuoteResponse {
  side: "buy" | "sell";
  phase: "curve" | "dex";
  tokensMicro: number;
  baseCostMicro: number;
  feeMicro: number;
  totalMicro: number;
  priceBeforeMicro: number;
  priceAfterMicro: number;
  priceImpactBps: number;
  progressBps: number;
  walletCapTokensMicro: number | null;
  availableMicro: number | null;
  walletCapReached: boolean;
  willGraduate: boolean;
  errors: string[];
  feeSplit: {
    developerMicro: number;
    platformGrossMicro: number;
    dividendMicro: number;
    platformNetMicro: number;
  };
}

export interface KingCandidate {
  id: string;
  status: string;
  tier: Tier;
  repoFullName: string;
  name: string;
  ticker: string;
  logoUrl: string;
  actor: string;
  volumeMicro: number;
  starVelocity: number;
  score: number;
  expiresAt: string;
}

export interface Bounty {
  id: string;
  tokenId: string;
  title: string;
  description: string;
  rewardMicro: number;
  status: "open" | "review" | "paid";
  creatorAddress: string;
  creatorName: string;
  claimantAddress: string | null;
  claimantName: string | null;
  submissionUrl: string | null;
  submissions: BountySubmission[];
  createdAt: string;
  paidAt: string | null;
  canApprove: boolean;
}

export interface BountySubmission {
  id: string;
  wallet: string;
  displayName: string;
  url: string;
  note: string | null;
  createdAt: string;
  selected: boolean;
}

export interface Proposal {
  id: string;
  tokenId: string;
  title: string;
  url: string;
  kind: "pr" | "issue" | "feature";
  status: "open" | "passed" | "closed";
  creatorAddress: string;
  votesYesMicro: number;
  votesNoMicro: number;
  myVote: "yes" | "no" | null;
  closesAt: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  wallet: string;
  displayName: string;
  avatarUrl: string;
  message: string;
  createdAt: string;
  role: "developer" | "holder" | "moderator";
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  displayName: string;
  xp: number;
  pnlMicro: number;
  trades: number;
  avatarUrl: string | null;
}

export interface ExploreResponse {
  tokens: TokenSummary[];
  total: number;
  page: number;
  pageSize: number;
  stats: {
    totalMarketCapMicro: number;
    volume24hMicro: number;
    developersEarnedMicro: number;
    holders: number;
    tokensLaunched: number;
  };
}

export interface PortfolioResponse {
  holdings: PortfolioHolding[];
  stakes: PortfolioStake[];
  earnings: PortfolioEarnings;
  fees: FeeCredit[];
  referrals: ReferralInfo;
  xp: number;
  rank: number;
  usdMicro: number;
  pnlMicro: number;
  developerLaunches: TokenSummary[];
  recentTrades: Trade[];
}

export interface PortfolioHolding {
  token: TokenSummary;
  amountMicro: number;
  valueMicro: number;
  costMicro: number;
  pnlMicro: number;
  pnlBps: number;
  stakedMicro: number;
  dividendsClaimableMicro: number;
  vestedMicro: number;
  vestedUntil: string | null;
}

export interface PortfolioStake {
  token: TokenSummary;
  amountMicro: number;
  valueMicro: number;
  lockDays: number;
  multiplierBps: number;
  unlockAt: string;
  pendingMicro: number;
}

export interface PortfolioEarnings {
  developerClaimableMicro: number;
  developerPaidMicro: number;
  dividendsClaimableMicro: number;
  dividendPaidMicro: number;
  referralMicro: number;
  referralClaimableMicro: number;
  totalClaimableMicro: number;
}

export interface FeeCredit {
  id: string;
  tokenId: string;
  tokenTicker: string;
  logoUrl: string;
  source: "developer" | "dividend" | "referral" | "bounty";
  amountMicro: number;
  claimedAt: string | null;
  createdAt: string;
}

export interface ReferralInfo {
  code: string;
  link: string;
  referredUsers: number;
  earnedMicro: number;
  shareBps: number;
}

export interface VerificationChallenge {
  challengeId: string;
  repo: string;
  code: string;
  line: string;
  expiresAt: string;
}

export interface VerifyResult {
  repo: RepoSummary;
  verified: boolean;
  wallet: string;
  readmeUrl: string;
  readmeSha: string;
  token: TokenSummary | null;
  canLaunch: boolean;
  claim: {
    available: boolean;
    tokenId: string | null;
    tokenName: string | null;
    unclaimedMicro: number;
    alreadyOwnedByYou: boolean;
  } | null;
  next: "launch" | "claim" | "existing";
  chain?: ChainTxInfo | null;
}

export interface LaunchInput {
  repo: string;
  mode: "owner" | "community";
  name: string;
  ticker: string;
  description: string;
  website?: string;
  twitter?: string;
  logoDataUrl?: string;
  verificationChallengeId?: string;
  paymentTxHash: string;
}

export interface HomeResponse {
  king: KingData | null;
  featured: TokenSummary[];
  fresh: TokenSummary[];
  trending: TokenSummary[];
  newLaunches: TokenSummary[];
  activity: ActivityItem[];
  stats: {
    totalMarketCapMicro: number;
    volume24hMicro: number;
    developersEarnedMicro: number;
    verifiedRepos: number;
    holders: number;
    tokensLaunched: number;
  };
  topTraders: LeaderboardEntry[];
}

export interface KingData {
  token: TokenSummary;
  volume1hMicro: number;
  starVelocity1h: number;
  score: number;
  since: string;
  endsAt: string;
}

export interface ApiErrorBody {
  error: string;
  code?: string;
  details?: unknown;
}

export interface ChartResponse {
  candles: ChartCandle[];
  points: PricePoint[];
  events: Array<{ time: number; label: string; type: string }>;
  interval: string;
}

export interface TokenTabData {
  trades: Trade[];
  holders: HolderPosition[];
  activity: ActivityItem[];
}
