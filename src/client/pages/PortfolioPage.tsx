import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Coins,
  Copy,
  ExternalLink,
  LayoutDashboard,
  LockKeyhole,
  PlusCircle,
  Sparkles,
  TrendingUp,
  Wallet,
} from "lucide-react";
import clsx from "clsx";
import type {
  PortfolioResponse,
  TokenSummary,
  UserProfile,
} from "../../shared/types.js";
import { api, ApiRequestError } from "../lib/api.js";
import {
  formatPercent,
  formatPrice,
  formatTimeAgo,
  formatTokens,
  formatUsd,
  truncateAddress,
} from "../../shared/format.js";
import { useAuth } from "../contexts/AuthContext.js";
import { useToast } from "../contexts/ToastContext.js";
import { AssetLogo, Sparkline } from "../components/AssetLogo.js";
import { Change, TierBadge } from "../components/Market.js";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ProgressBar,
  Skeleton,
  buttonClass,
} from "../components/ui.js";

type PortfolioData = PortfolioResponse & {
  user: UserProfile;
  nearBalanceYocto: string;
  nearUsd: number;
  claimable: Array<{ tokenId: string; ticker: string; devFees: string; rewards: string }>;
  contractId: string;
  network: string;
};

const YOCTO_PER_NEAR = 10n ** 24n;

function nearFromYocto(value: string | bigint, digits = 4): string {
  const raw = typeof value === "bigint" ? value : BigInt(value || "0");
  const whole = raw / YOCTO_PER_NEAR;
  const fraction = raw % YOCTO_PER_NEAR;
  const decimals = fraction.toString().padStart(24, "0").slice(0, digits).replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${decimals ? `.${decimals}` : ""}`;
}

export function PortfolioPage() {
  const { user, nearWallet, openAuth, loading } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"positions" | "stakes" | "earnings" | "launches">("positions");

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["portfolio"],
    queryFn: () => api<PortfolioData>("/api/portfolio"),
    enabled: Boolean(user),
    staleTime: 10_000,
  });

  const { data: marketStrip } = useQuery({
    queryKey: ["market-strip"],
    queryFn: () => api<{ tokens: TokenSummary[] }>("/api/tokens?sort=volume&pageSize=3"),
    enabled: Boolean(user),
    staleTime: 30_000,
  });

  const claim = useMutation({
    mutationFn: async ({ tokenId, kind }: { tokenId: string; kind: "developer" | "rewards" }) => {
      if (!data || !nearWallet || !user) {
        throw new ApiRequestError("Connect your NEAR wallet first.", 401, "AUTH_REQUIRED");
      }
      const accounts = await nearWallet.getAccounts({
        network: data.network === "mainnet" ? "mainnet" : "testnet",
      });
      return nearWallet.signAndSendTransaction({
        receiverId: data.contractId,
        signerId: accounts[0]?.accountId ?? user.address,
        actions: [
          {
            type: "FunctionCall" as const,
            params: {
              methodName:
                kind === "developer" ? "claim_developer_fees" : "claim_staking_rewards",
              args: { token_id: tokenId },
              gas: "100000000000000",
              deposit: "0",
            },
          },
        ],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["onchain"] });
      notify("Claim sent by your wallet and settled on the market contract.", {
        kind: "success",
        title: "On-chain claim",
      });
    },
    onError: (error) =>
      notify(error instanceof Error ? error.message : "Claim failed.", { kind: "error" }),
  });

  if (loading) return <PortfolioSkeleton />;
  if (!user) {
    return (
      <div className="page portfolio-page">
        <div className="portfolio-guest">
          <div className="portfolio-guest-grid" aria-hidden="true" />
          <div className="eyebrow">
            <Wallet size={12} /> Portfolio
          </div>
          <h1 className="page-title">
            Your positions.
            <br />
            <em>One on-chain book.</em>
          </h1>
          <p>
            Connect your NEAR wallet to track real contract balances, cost basis, fee yield and
            every on-chain fill in one place.
          </p>
          <div className="portfolio-guest-actions">
            <Button variant="primary" size="lg" onClick={openAuth} icon={<Wallet size={15} />}>
              Connect NEAR
            </Button>
            <Link to="/explore" className={buttonClass("secondary", "lg")}>
              Browse markets
            </Link>
          </div>
          <div className="portfolio-guest-features">
            <div>
              <Coins size={15} />
              <span>On-chain balances</span>
            </div>
            <div>
              <BadgeCheck size={15} />
              <span>Real fee yield</span>
            </div>
            <div>
              <TrendingUp size={15} />
              <span>Live USD pricing</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading || !data) return <PortfolioSkeleton />;
  if (isError) {
    return (
      <div className="page">
        <EmptyState
          title="Portfolio unavailable"
          body="The market index could not be read. Retry."
          icon={<LayoutDashboard size={24} />}
          action={<Button onClick={() => refetch()}>Retry</Button>}
        />
      </div>
    );
  }

  const holdingsValue = data.holdings.reduce((sum, holding) => sum + holding.valueMicro, 0);
  const netWorth = holdingsValue + data.usdMicro;
  const totalPnl = data.pnlMicro;
  const composition = [
    ...data.holdings.map((holding) => ({
      label: holding.token.ticker,
      value: holding.valueMicro,
    })),
    { label: "NEAR", value: data.usdMicro },
  ]
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value);

  return (
    <div className="page portfolio-page">
      <div className="portfolio-head">
        <div>
          <div className="eyebrow">
            <LayoutDashboard size={12} /> NEAR account
          </div>
          <h1 className="page-title">
            Your <em>book.</em>
          </h1>
        </div>
        <div className="portfolio-wallet">
          <span className="portfolio-avatar">{user.displayName.slice(0, 2).toUpperCase()}</span>
          <div>
            <strong>{user.displayName}</strong>
            <span className="mono">
              {truncateAddress(user.address, 10, 5)}{" "}
              <CopyButton text={user.address} label="" className="icon-copy" />
            </span>
          </div>
          <Badge tone="green">NEAR</Badge>
        </div>
      </div>

      <div className="portfolio-metrics">
        <div className="portfolio-networth">
          <span className="metric-label">NET WORTH</span>
          <strong className="portfolio-big mono">{formatUsd(netWorth)}</strong>
          <div className="portfolio-networth-sub">
            <span className="mono">{formatUsd(holdingsValue)} in positions</span>
            <span className="mono">
              {nearFromYocto(data.nearBalanceYocto)} NEAR · {formatUsd(data.usdMicro)}
            </span>
          </div>
          <div className="composition-bar">
            {composition.slice(0, 8).map((item, index) => (
              <span
                key={item.label}
                style={{
                  width: `${(item.value / Math.max(1, netWorth)) * 100}%`,
                  background: `hsl(${74 + index * 38} 60% ${50 + index * 3}%)`,
                }}
                title={`${item.label}: ${formatUsd(item.value)}`}
              />
            ))}
          </div>
        </div>
        <div className="portfolio-metric-card">
          <span className="metric-label">WALLET</span>
          <strong className="mono">{nearFromYocto(data.nearBalanceYocto)} NEAR</strong>
          <span className="metric-sub">
            {formatUsd(data.usdMicro)} at live NEAR ${data.nearUsd.toFixed(3)}
          </span>
        </div>
        <div className="portfolio-metric-card">
          <span className="metric-label">TOTAL P&L</span>
          <strong className={clsx("mono", totalPnl >= 0 ? "text-positive" : "text-negative")}>
            {formatUsd(totalPnl, { sign: true })}
          </strong>
          <span className="metric-sub">open positions vs on-chain cost</span>
        </div>
        <div className="portfolio-metric-card">
          <span className="metric-label">CLAIMABLE</span>
          <strong className="mono">{formatUsd(data.earnings.totalClaimableMicro)}</strong>
          <span className="metric-sub">developer fees + staking rewards</span>
        </div>
      </div>

      <div className="portfolio-grid">
        <div className="portfolio-main">
          <Card className="positions-card">
            <div className="portfolio-tabs">
              <button className={clsx(tab === "positions" && "active")} onClick={() => setTab("positions")}>
                Positions <span className="mono">{data.holdings.length}</span>
              </button>
              <button className={clsx(tab === "stakes" && "active")} onClick={() => setTab("stakes")}>
                Stakes <span className="mono">{data.stakes.length}</span>
              </button>
              <button className={clsx(tab === "earnings" && "active")} onClick={() => setTab("earnings")}>
                Fee ledger
              </button>
              <button className={clsx(tab === "launches" && "active")} onClick={() => setTab("launches")}>
                My launches <span className="mono">{data.developerLaunches.length}</span>
              </button>
              <span className="portfolio-tabs-right mono">ON-CHAIN · USD DISPLAY</span>
            </div>

            {tab === "positions" ? (
              data.holdings.length ? (
                <div className="positions-table">
                  <div className="positions-head mono">
                    <span>ASSET</span>
                    <span>POSITION</span>
                    <span>VALUE</span>
                    <span>P&L</span>
                    <span>YIELD</span>
                    <span>WEIGHT</span>
                    <span />
                  </div>
                  {data.holdings.map((holding) => (
                    <div className="position-row" key={holding.token.id}>
                      <div className="position-asset">
                        <AssetLogo src={holding.token.logoUrl} ticker={holding.token.ticker} size={34} />
                        <div>
                          <Link to={`/real/${holding.token.id}`} className="position-ticker">
                            ${holding.token.ticker}
                          </Link>
                          <span className="mono">{truncateAddress(holding.token.repo.fullName, 17, 0)}</span>
                        </div>
                      </div>
                      <div className="position-amount">
                        <strong className="mono">{formatTokens(holding.amountMicro, { compact: true })}</strong>
                        <span className="mono">{formatUsd(holding.valueMicro)}</span>
                      </div>
                      <span className="mono">{formatUsd(holding.valueMicro)}</span>
                      <div className={clsx("mono", holding.pnlMicro >= 0 ? "text-positive" : "text-negative")}>
                        {formatUsd(holding.pnlMicro, { sign: true })}
                        <span>{formatPercent(holding.pnlBps, { sign: true })}</span>
                      </div>
                      <div className="position-yield">
                        <span className="mono">{holding.stakedMicro ? "STAKED" : "LIQUID"}</span>
                        <span className="mono text-positive">
                          {formatUsd(holding.dividendsClaimableMicro)}
                        </span>
                      </div>
                      <div className="position-weight">
                        <ProgressBar value={netWorth ? (holding.valueMicro / netWorth) * 100 : 0} />
                        <span className="mono">
                          {formatPercent(netWorth ? (holding.valueMicro / netWorth) * 10_000 : 0)}
                        </span>
                      </div>
                      <div className="position-row-actions">
                        <Link to={`/real/${holding.token.id}`} className={buttonClass("secondary", "xs")}>
                          Trade <ArrowUpRight size={11} />
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="No positions yet"
                  body="Your first buy opens a real on-chain position with live USD P&L and fee yield."
                  icon={<TrendingUp size={24} />}
                  action={
                    <Link to="/explore" className={buttonClass("primary")}>
                      Find a repo <ArrowRight size={13} />
                    </Link>
                  }
                />
              )
            ) : null}

            {tab === "stakes" ? (
              data.stakes.length ? (
                <div className="stakes-table">
                  <div className="stakes-head mono">
                    <span>ASSET</span>
                    <span>STAKED</span>
                    <span>VALUE</span>
                    <span>REWARDS</span>
                    <span>STATUS</span>
                    <span />
                  </div>
                  {data.stakes.map((stake) => (
                    <div className="stake-row" key={stake.token.id}>
                      <div className="position-asset">
                        <AssetLogo src={stake.token.logoUrl} ticker={stake.token.ticker} size={32} />
                        <div>
                          <Link to={`/real/${stake.token.id}`} className="position-ticker">
                            ${stake.token.ticker}
                          </Link>
                          <span className="mono">0.5% trade fee yield</span>
                        </div>
                      </div>
                      <strong className="mono">{formatTokens(stake.amountMicro, { compact: true })}</strong>
                      <span className="mono">{formatUsd(stake.valueMicro)}</span>
                      <span className="mono text-positive">{formatUsd(stake.pendingMicro)}</span>
                      <div className="stake-unlock">
                        <span className="mono text-positive">UNLOCKED</span>
                        <span className="mono muted">NO LOCK</span>
                      </div>
                      <Link to={`/real/${stake.token.id}`} className={buttonClass("ghost", "xs")}>
                        Manage <ArrowRight size={11} />
                      </Link>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="No active stakes"
                  body="Stake tokens in a repo market to earn 0.5% of every trade, paid in NEAR."
                  icon={<LockKeyhole size={24} />}
                  action={
                    <Link to="/explore" className={buttonClass("secondary")}>
                      Find yield
                    </Link>
                  }
                />
              )
            ) : null}

            {tab === "earnings" ? (
              <div className="earnings-panel">
                <div className="earnings-grid">
                  <div>
                    <span>DEVELOPER CLAIMABLE</span>
                    <strong className="mono">{formatUsd(data.earnings.developerClaimableMicro)}</strong>
                    <em>0.5% of every trade</em>
                  </div>
                  <div>
                    <span>STAKING REWARDS</span>
                    <strong className="mono text-positive">
                      {formatUsd(data.earnings.dividendsClaimableMicro)}
                    </strong>
                    <em>0.5% fee yield</em>
                  </div>
                  <div>
                    <span>REFERRALS</span>
                    <strong className="mono">Not on-chain</strong>
                    <em>removed from settlement</em>
                  </div>
                  <div>
                    <span>LIFETIME DEVELOPER PAID</span>
                    <strong className="mono">{formatUsd(data.earnings.developerPaidMicro)}</strong>
                    <em>contract royalties</em>
                  </div>
                </div>
                <div className="fee-ledger">
                  <div className="fee-ledger-head mono">
                    <span>SOURCE</span>
                    <span>ASSET</span>
                    <span>AMOUNT</span>
                    <span>STATUS</span>
                    <span>WHEN</span>
                  </div>
                  {data.fees.length ? (
                    data.fees.map((fee) => (
                      <div className="fee-ledger-row" key={fee.id}>
                        <span>
                          <i className={`fee-dot fee-${fee.source}`} /> {fee.source}
                        </span>
                        <span className="mono asset-cell">
                          <img src={fee.logoUrl} alt="" /> ${fee.tokenTicker}
                        </span>
                        <strong className="mono">{formatUsd(fee.amountMicro)}</strong>
                        <span className="mono text-positive">claimable</span>
                        <span className="mono muted">{formatTimeAgo(fee.createdAt)}</span>
                      </div>
                    ))
                  ) : (
                    <p className="muted">Fees will appear here as your assets trade.</p>
                  )}
                </div>
              </div>
            ) : null}

            {tab === "launches" ? (
              data.developerLaunches.length ? (
                <div className="launch-list">
                  {data.developerLaunches.map((token) => (
                    <Link to={`/real/${token.id}`} className="launch-list-row" key={token.id}>
                      <AssetLogo src={token.logoUrl} ticker={token.ticker} size={38} />
                      <div>
                        <strong>${token.ticker}</strong>
                        <span>{token.name}</span>
                      </div>
                      <TierBadge tier={token.tier} short />
                      <span className="mono">{formatPercent(token.progressBps, { decimals: 0 })} curve</span>
                      <span className="mono">{formatUsd(token.volume24hMicro, { compact: true })} vol</span>
                      <span className="mono text-positive">{formatUsd(token.marketCapMicro, { compact: true })}</span>
                      <ArrowUpRight size={13} />
                    </Link>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="You haven't launched a repo"
                  body="Verify a public repository and create a real on-chain market."
                  icon={<PlusCircle size={24} />}
                  action={
                    <Link to="/launch" className={buttonClass("primary")}>
                      Launch a repo
                    </Link>
                  }
                />
              )
            ) : null}
          </Card>

          <Card className="recent-trades-card">
            <div className="side-card-head">
              <span className="eyebrow">Recent on-chain fills</span>
              <span className="mono">{data.recentTrades.length} TRADES</span>
            </div>
            {data.recentTrades.length ? (
              <div className="recent-trades">
                <div className="recent-trades-head mono">
                  <span>SIDE</span>
                  <span>ASSET</span>
                  <span>AMOUNT</span>
                  <span>TOTAL</span>
                  <span>PRICE</span>
                  <span>WHEN</span>
                </div>
                {data.recentTrades.slice(0, 8).map((trade) => (
                  <div className="recent-trade-row" key={trade.id}>
                    <span className={clsx("mono", trade.side === "buy" ? "text-positive" : "text-negative")}>
                      {trade.side.toUpperCase()}
                    </span>
                    <span className="mono">
                      {trade.tokenTicker ? `$${trade.tokenTicker}` : truncateAddress(trade.wallet, 8, 4)}
                    </span>
                    <span className="mono">{formatTokens(trade.tokensMicro, { compact: true })}</span>
                    <span className="mono">{formatUsd(trade.usdMicro)}</span>
                    <span className="mono">{formatPrice(trade.priceMicro)}</span>
                    <span className="mono muted">{formatTimeAgo(trade.createdAt)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted empty-inline">No trades yet. Your first on-chain fill shows here.</p>
            )}
          </Card>

          <Card className="portfolio-discover">
            <div className="side-card-head">
              <span className="eyebrow">Markets worth a look</span>
              <Link to="/explore" className="text-link">
                Full market <ArrowRight size={11} />
              </Link>
            </div>
            <div className="discover-grid">
              {(marketStrip?.tokens ?? []).map((token) => (
                <Link to={`/real/${token.id}`} className="discover-card" key={token.id}>
                  <AssetLogo src={token.logoUrl} ticker={token.ticker} size={32} />
                  <div>
                    <strong>${token.ticker}</strong>
                    <span className="mono">{token.repo.fullName}</span>
                  </div>
                  <div className="discover-right">
                    <strong className="mono">{formatUsd(token.marketCapMicro, { compact: true })}</strong>
                    <Change bps={token.change24hBps} />
                  </div>
                </Link>
              ))}
            </div>
          </Card>
        </div>

        <aside className="portfolio-side">
          <Card className="claim-card">
            <div className="claim-card-glow" aria-hidden="true" />
            <div className="side-card-head">
              <span className="eyebrow">Claimable</span>
              <Coins size={14} />
            </div>
            <strong className="claim-amount mono">{formatUsd(data.earnings.totalClaimableMicro)}</strong>
            <span className="claim-sub">developer royalties + staking rewards, claimable per market</span>
            <div className="claim-breakdown">
              <div>
                <span>Developer</span>
                <span className="mono">{formatUsd(data.earnings.developerClaimableMicro)}</span>
              </div>
              <div>
                <span>Staking</span>
                <span className="mono">{formatUsd(data.earnings.dividendsClaimableMicro)}</span>
              </div>
            </div>
            {data.claimable.length ? (
              <div className="claim-rows">
                {data.claimable.slice(0, 4).map((item) => (
                  <div className="claim-row" key={item.tokenId}>
                    <span className="mono">${item.ticker}</span>
                    <div>
                      {BigInt(item.devFees) > 0n ? (
                        <Button
                          size="xs"
                          variant="secondary"
                          loading={claim.isPending}
                          onClick={() => claim.mutate({ tokenId: item.tokenId, kind: "developer" })}
                        >
                          Dev
                        </Button>
                      ) : null}
                      {BigInt(item.rewards) > 0n ? (
                        <Button
                          size="xs"
                          variant="secondary"
                          loading={claim.isPending}
                          onClick={() => claim.mutate({ tokenId: item.tokenId, kind: "rewards" })}
                        >
                          Stake
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="claim-empty">Nothing to claim yet. Fees accrue on-chain.</p>
            )}
            <div className="claim-note mono">
              <LockKeyhole size={10} /> WALLET-SIGNED · PAID IN NEAR
            </div>
          </Card>

          <Card className="referral-card">
            <div className="side-card-head">
              <span className="eyebrow">Settlement</span>
              <BadgeCheck size={14} />
            </div>
            <h3>
              Real balances.
              <br />
              <em>Live USD marks.</em>
            </h3>
            <p>
              Every position, cost basis and fill is read from the GitFi market contract on NEAR{" "}
              {data.network}. Prices are shown in USD using a live NEAR/USD quote.
            </p>
            <div className="referral-stats">
              <div>
                <span>NEAR/USD</span>
                <strong className="mono">${data.nearUsd.toFixed(3)}</strong>
              </div>
              <div>
                <span>CONTRACT</span>
                <strong className="mono">{truncateAddress(data.contractId, 9, 5)}</strong>
              </div>
              <div>
                <span>MODE</span>
                <strong className="mono">ON-CHAIN</strong>
              </div>
            </div>
            <a
              href={`${data.network === "mainnet" ? "https://explorer.near.org" : "https://explorer.testnet.near.org"}/accounts/${data.contractId}`}
              target="_blank"
              rel="noreferrer"
              className="text-link"
            >
              View market contract <ExternalLink size={11} />
            </a>
          </Card>

          <Card className="referral-card">
            <div className="side-card-head">
              <span className="eyebrow">Builder economics</span>
              <Sparkles size={14} />
            </div>
            <h3>
              Royalties that
              <br />
              <em>pay on-chain.</em>
            </h3>
            <p>
              The repo owner receives 0.5% of every trade, stakers receive 0.5%, and the
              team receives 0.3%, all claimable directly from the contract. No demo balances.
            </p>
            <Link to="/launch" className={buttonClass("primary", "sm", "full-width")}>
              Launch a repository <ArrowRight size={12} />
            </Link>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function PortfolioSkeleton() {
  return (
    <div className="page portfolio-page">
      <Skeleton style={{ width: 240, height: 46 }} />
      <div className="portfolio-metrics">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} style={{ height: 132 }} />
        ))}
      </div>
      <div className="portfolio-grid">
        <Skeleton style={{ height: 440 }} />
        <Skeleton style={{ height: 440 }} />
      </div>
    </div>
  );
}
