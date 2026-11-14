import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  GitBranch,
  LockKeyhole,
  TrendingUp,
  Trophy,
} from "lucide-react";
import type { HomeResponse, TokenSummary } from "../../shared/types.js";
import { api } from "../lib/api.js";
import { smoothPath } from "../lib/chart.js";
import {
  formatPercent,
  formatPrice,
  formatUsd,
  formatCompact,
  shortNumber,
} from "../../shared/format.js";
import { AssetLogo } from "../components/AssetLogo.js";
import {
  ActivityFeed,
  Change,
  FreshTokenCard,
  MarketTable,
  TierBadge,
  VerificationBadge,
} from "../components/Market.js";
import {
  Badge,
  buttonClass,
  Card,
  EmptyState,
  LiveDot,
  ProgressBar,
  SectionHead,
  Skeleton,
} from "../components/ui.js";
import { useRealtimeEvent } from "../contexts/RealtimeContext.js";

function HomeSkeleton() {
  return (
    <div className="page home-page">
      <section className="hero">
        <div className="hero-copy">
          <Skeleton style={{ width: 240, height: 14 }} />
          <Skeleton style={{ width: "92%", height: 72, marginTop: 28 }} />
          <Skeleton style={{ width: "76%", height: 72, marginTop: 8 }} />
          <Skeleton style={{ width: "68%", height: 18, marginTop: 28 }} />
          <Skeleton style={{ width: "58%", height: 18, marginTop: 10 }} />
          <div className="hero-actions"><Skeleton style={{ width: 160, height: 44 }} /><Skeleton style={{ width: 150, height: 44 }} /></div>
        </div>
        <Skeleton className="hero-panel-skeleton" />
      </section>
      <Skeleton style={{ height: 78, marginTop: 32 }} />
      <div className="section-block">
        <Skeleton style={{ width: 200, height: 26 }} />
        <div className="fresh-grid">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} style={{ height: 210 }} />)}
        </div>
      </div>
    </div>
  );
}

function TerminalChart({ token, price }: { token: TokenSummary; price: number }) {
  const width = 490;
  const height = 126;
  const pad = 10;
  const source = token.sparkline.length ? [...token.sparkline] : [price * 0.985, price];
  const raw = source.map((_, index) => {
    let total = 0;
    let count = 0;
    for (let offset = -2; offset <= 2; offset += 1) {
      const value = source[index + offset];
      if (value === undefined) continue;
      total += value;
      count += 1;
    }
    return total / Math.max(1, count);
  });
  raw[raw.length - 1] = price;
  const min = Math.min(...raw);
  const max = Math.max(...raw);
  const span = Math.max(1, max - min);
  const low = min - span * 0.08;
  const high = max + span * 0.08;
  const points = raw.map((value, index) => ({
    x: pad + (index / Math.max(1, raw.length - 1)) * (width - pad * 2),
    y: pad + (1 - (value - low) / (high - low)) * (height - pad * 2),
  }));
  const line = smoothPath(points);
  const area = `${line} L ${points[points.length - 1]!.x.toFixed(2)} ${height} L ${points[0]!.x.toFixed(2)} ${height} Z`;
  const up = token.change24hBps >= 0;
  const tone = up ? "var(--positive)" : "var(--negative)";
  return (
    <div className="terminal-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="terminal-chart-svg"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${token.ticker} 24 hour price chart`}
      >
        <defs>
          <linearGradient id={`hero-grad-${token.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone} stopOpacity="0.26" />
            <stop offset="72%" stopColor={tone} stopOpacity="0.05" />
            <stop offset="100%" stopColor={tone} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.22, 0.44, 0.66, 0.88].map((position) => (
          <line
            key={position}
            x1="0"
            x2={width}
            y1={height * position}
            y2={height * position}
            className="hero-chart-grid"
          />
        ))}
        <path
          key={`area-${token.id}`}
          d={area}
          fill={`url(#hero-grad-${token.id})`}
          className="hero-chart-area"
        />
        <path
          key={`line-${token.id}`}
          d={line}
          fill="none"
          stroke={tone}
          strokeWidth="2"
          strokeLinecap="round"
          pathLength={1}
          className="hero-chart-line"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          cx={points[points.length - 1]!.x}
          cy={points[points.length - 1]!.y}
          r="3.6"
          fill={tone}
          className="hero-chart-dot"
        />
      </svg>
      <span className="terminal-chart-label mono">24H PRICE · LIVE</span>
    </div>
  );
}

function HeroTerminal({ home }: { home: HomeResponse }) {
  const tokens = useMemo(() => {
    const seen = new Set<string>();
    const list: TokenSummary[] = [];
    for (const token of [...home.trending, ...home.featured, ...home.fresh]) {
      if (seen.has(token.id)) continue;
      seen.add(token.id);
      list.push(token);
      if (list.length === 10) break;
    }
    return list;
  }, [home.trending, home.featured, home.fresh]);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});

  useEffect(() => {
    if (tokens.length < 2 || paused) return undefined;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % tokens.length);
    }, 5600);
    return () => window.clearInterval(timer);
  }, [tokens.length, paused]);

  useEffect(() => {
    if (index >= tokens.length) setIndex(0);
  }, [index, tokens.length]);

  useRealtimeEvent((event) => {
    if (event.type !== "trade") return;
    const payload = event.data as { tokenId?: string; priceMicro?: number };
    if (!payload.tokenId || !payload.priceMicro) return;
    setLivePrices((current) => ({ ...current, [payload.tokenId!]: payload.priceMicro! }));
  });

  const token = tokens[index] ?? tokens[0];
  if (!token) {
    return (
      <div className="hero-terminal hero-terminal-empty">
        <div className="terminal-top">
          <span className="terminal-dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="mono terminal-path">gitfi://markets/empty</span>
        </div>
        <div className="hero-empty-body">
          <span className="eyebrow">Clean on-chain market</span>
          <h3>No real markets yet.</h3>
          <p>
            Every listed token is created only by its verified repository owner.
            Prove a README and launch the first market.
          </p>
          <Link to="/launch" className={buttonClass("primary", "sm")}>
            Launch the first repo <ArrowRight size={13} />
          </Link>
        </div>
      </div>
    );
  }
  const price = livePrices[token.id] ?? token.priceMicro;
  const change = token.change24hBps;

  return (
    <div
      className="hero-terminal"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="terminal-top">
        <span className="terminal-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="mono terminal-path">gitfi://markets/{token.ticker.toLowerCase()}</span>
      </div>

      <div className="terminal-live-body" key={token.id}>
        <div className="terminal-head">
          <div className="terminal-asset">
            <AssetLogo src={token.logoUrl} ticker={token.ticker} size={44} />
            <div>
              <div className="terminal-symbol">
                <strong>${token.ticker}</strong>
                {token.verification === "verified" ? <BadgeCheck size={14} /> : null}
              </div>
              <span className="mono terminal-repo">{token.repo.fullName}</span>
            </div>
          </div>
          <TierBadge tier={token.tier} short />
        </div>

        <div className="terminal-price-row">
          <div>
            <span className="terminal-price mono">{formatPrice(price)}</span>
            <Change bps={change} />
          </div>
          <span className="terminal-mcap mono">FDV {formatUsd(token.marketCapMicro, { compact: true })}</span>
        </div>

        <TerminalChart token={token} price={price} />

        <div className="terminal-progress">
          <div className="terminal-progress-label">
            <span>{token.status === "graduated" ? "Market graduated" : "Bonding curve"}</span>
            <span className="mono">{token.status === "graduated" ? "GRADUATED" : `${formatPercent(token.progressBps, { decimals: 0 })} filled`}</span>
          </div>
          <ProgressBar value={token.progressBps / 100} tone={token.tier === "viral" ? "red" : token.tier === "rising" ? "amber" : "lime"} />
        </div>

        <div className="terminal-metrics">
          <div><span>24H VOL</span><strong className="mono">{formatUsd(token.volume24hMicro, { compact: true })}</strong></div>
          <div><span>★ STARS</span><strong className="mono">{shortNumber(token.repo.stars)}</strong></div>
          <div><span>HOLDERS</span><strong className="mono">{token.holderCount}</strong></div>
        </div>
      </div>

      <div className="terminal-rank-row">
        <span className="mono">TOP 10 TRENDING</span>
        <div className="terminal-dots-nav" role="tablist" aria-label="Trending markets">
          {tokens.map((item, itemIndex) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={itemIndex === index}
              aria-label={`Show ${item.ticker}`}
              className={itemIndex === index ? "active" : ""}
              onClick={() => setIndex(itemIndex)}
            />
          ))}
        </div>
        <span className="mono">{paused ? "PAUSED" : "AUTO"}</span>
      </div>

      <Link to={`/real/${token.id}`} className="terminal-cta">
        <span>Open ${token.ticker}</span>
        <ArrowRight size={15} />
      </Link>
    </div>
  );
}

const MECHANICS = [
  {
    index: "01",
    icon: <BadgeCheck size={18} />,
    title: "Proof, not OAuth",
    copy: "Paste one sync line into a public README. The repo is bound to a wallet and minted as a unique Repo NFT.",
    meta: "Zero GitHub permissions",
  },
  {
    index: "02",
    icon: <TrendingUp size={18} />,
    title: "A market from the first buy",
    copy: "Fair-launch curves price the work in public. At graduation the market stays open on-chain with no team allocation.",
    meta: "No team allocation",
  },
  {
    index: "03",
    icon: <LockKeyhole size={18} />,
    title: "Yield with substance",
    copy: "Developers earn 0.5% of every trade. Stakers earn 0.5%, and the team earns 0.3%, all settled in NEAR by the contract.",
    meta: "Real fee-backed yield",
  },
];

export function HomePage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["home"],
    queryFn: () => api<HomeResponse>("/api/home"),
    staleTime: 12_000,
    refetchInterval: 30_000,
  });

  if (isLoading) return <HomeSkeleton />;
  if (isError || !data) {
    return (
      <div className="page">
        <EmptyState
          title="The protocol didn’t respond"
          body="The market feed could not be reached. Refresh to reconnect."
          icon={<GitBranch size={24} />}
          action={<button className={buttonClass("primary")} onClick={() => window.location.reload()}>Reload</button>}
        />
      </div>
    );
  }

  return (
    <div className="page home-page">
      <section className="hero">
        <div className="hero-copy">
          <h1 className="hero-title">
            Invest in the code
          </h1>
          <p className="hero-sub">
            GitFi turns public GitHub repositories into verified utility tokens.
            Developers earn royalties, traders price momentum, holders earn real yield.
          </p>
          <div className="hero-actions">
            <Link to="/explore" className={buttonClass("primary", "lg")}>
              Explore markets <ArrowRight size={16} />
            </Link>
            <Link to="/launch" className={buttonClass("secondary", "lg")}>
              Launch a repo <ArrowUpRight size={16} />
            </Link>
          </div>
          <div className="hero-trust mono">
            <span><BadgeCheck size={12} /> NO GITHUB OAUTH</span>
            <span><GitBranch size={12} /> PUBLIC REPOS ONLY</span>
          </div>
        </div>
        <div className="hero-visual">
          <HeroTerminal home={data} />
        </div>
      </section>

      <div className="metric-band">
        <div className="metric-band-cell">
          <span className="metric-label">TOTAL MARKET CAP</span>
          <strong className="metric-value mono">{formatUsd(data.stats.totalMarketCapMicro, { compact: true })}</strong>
          <span className="metric-sub">across {data.stats.tokensLaunched} live assets</span>
        </div>
        <div className="metric-band-cell">
          <span className="metric-label">24H VOLUME</span>
          <strong className="metric-value mono">{formatUsd(data.stats.volume24hMicro, { compact: true })}</strong>
          <span className="metric-sub">settled on NEAR testnet</span>
        </div>
        <div className="metric-band-cell">
          <span className="metric-label">DEVELOPER ROYALTIES</span>
          <strong className="metric-value mono">{formatUsd(data.stats.developersEarnedMicro, { compact: true })}</strong>
          <span className="metric-sub">unclaimed, 0.5% per trade</span>
        </div>
        <div className="metric-band-cell">
          <span className="metric-label">VERIFIED REPOSITORIES</span>
          <strong className="metric-value mono">{data.stats.verifiedRepos}</strong>
          <span className="metric-sub">{data.stats.holders} unique holders</span>
        </div>
      </div>

      {data.fresh.length > 0 ? (
        <section className="section-block no-top-border">
          <SectionHead
            eyebrow="Undiscovered, not unloved"
            title={<>Fresh <em>gems</em></>}
            action={<Link to="/explore?tier=seed" className="text-link">All seed repos <ArrowRight size={13} /></Link>}
          />
          <div className="fresh-grid">
            {data.fresh.map((token, index) => (
              <FreshTokenCard key={token.id} token={token} index={index} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="section-block">
        <SectionHead
          eyebrow="Price discovery, live"
          title={<>The market <em>right now</em></>}
          action={
            <div className="section-head-actions">
              <LiveDot label="streaming" />
              <Link to="/explore" className="text-link">Full market <ArrowRight size={13} /></Link>
            </div>
          }
        />
        <div className="market-layout">
          <Card className="market-main-card">
            <div className="market-card-top">
              <div className="market-card-tabs">
                <span className="mini-tab mini-tab-active">Trending</span>
                <Link to="/explore?sort=new" className="mini-tab">New</Link>
                <Link to="/explore?tier=seed" className="mini-tab">Seed</Link>
                <Link to="/explore?tier=viral" className="mini-tab">Viral</Link>
              </div>
              <span className="market-card-meta mono">{data.stats.tokensLaunched} ASSETS · 1.3% FEE</span>
            </div>
            <MarketTable
              tokens={data.trending}
              loading={false}
              emptyTitle="No real markets yet"
              emptyBody="Only the verified repository owner can create a market. Prove a README to launch the first one."
            />
          </Card>
          <div className="home-side">
            <Card className="activity-card">
              <ActivityFeed items={data.activity} compact limit={8} />
              <Link to="/leaderboard" className="card-footer-link">Protocol activity <ArrowRight size={12} /></Link>
            </Card>
            <Card className="traders-card">
              <div className="side-card-head">
                <span className="eyebrow">XP LEADERS</span>
                <Trophy size={14} />
              </div>
              {data.topTraders.slice(0, 5).map((trader) => (
                <div className="trader-row" key={trader.address}>
                  <span className="trader-rank mono">{String(trader.rank).padStart(2, "0")}</span>
                  <span className="trader-avatar">{trader.displayName.slice(0, 2).toUpperCase()}</span>
                  <div className="trader-copy">
                    <strong>{trader.displayName}</strong>
                    <span className="mono">{trader.trades} trades</span>
                  </div>
                  <div className="trader-right">
                    <strong className="mono">{formatCompact(trader.xp)}</strong>
                    <span className={trader.pnlMicro >= 0 ? "text-positive" : "text-negative"}>
                      {formatUsd(trader.pnlMicro, { compact: true, sign: true })}
                    </span>
                  </div>
                </div>
              ))}
              <Link to="/leaderboard" className="card-footer-link">Full leaderboard <ArrowRight size={12} /></Link>
            </Card>
          </div>
        </div>
      </section>

      <section className="mechanic-section">
        <div className="mechanic-intro">
          <span className="eyebrow">A three-sided protocol</span>
          <h2 className="mechanic-title">Aligned by the<br /><em>same fee.</em></h2>
          <p>One point three percent per trade. No hidden allocations. Creators earn royalties, stakers earn the fee yield, the team keeps the protocol running, and every fill settles on NEAR.</p>
          <div className="fee-equation">
            <div><strong>0.50%</strong><span>creator</span></div>
            <span className="fee-plus">+</span>
            <div><strong>0.30%</strong><span>team</span></div>
            <span className="fee-plus">+</span>
            <div><strong>0.50%</strong><span>stakers</span></div>
            <span className="fee-equals">=</span>
            <div className="fee-total"><strong>1.30%</strong><span>per trade</span></div>
          </div>
        </div>
        <div className="mechanics">
          {MECHANICS.map((mechanic) => (
            <div className="mechanic" key={mechanic.index}>
              <div className="mechanic-top">
                <span className="mechanic-icon">{mechanic.icon}</span>
                <span className="mechanic-index mono">{mechanic.index}</span>
              </div>
              <h3>{mechanic.title}</h3>
              <p>{mechanic.copy}</p>
              <span className="mechanic-meta mono">{mechanic.meta}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="launch-band">
        <div className="launch-band-content">
          <div className="launch-band-copy">
            <span className="eyebrow">Free marketing for small repos</span>
            <h2>Your repo is worth more than stars.</h2>
            <p>Raise attention without giving away ownership. Keep your code public and let the market fund the next commit.</p>
          </div>
          <div className="launch-band-actions">
            <Link to="/launch" className={buttonClass("primary", "lg")}>
              Launch your repository <ArrowRight size={16} />
            </Link>
            <span className="mono">30s SETUP · NO OAUTH</span>
          </div>
        </div>
        <div className="launch-band-mark" aria-hidden="true">
          <GitBranch size={150} strokeWidth={0.6} />
        </div>
      </section>
    </div>
  );
}
