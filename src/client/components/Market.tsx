import { Link, useNavigate } from "react-router-dom";
import clsx from "clsx";
import {
  ArrowDownRight,
  ArrowUpRight,
  Award,
  BadgeCheck,
  CircleDollarSign,
  Flame,
  GitBranch,
  GitCommitHorizontal,
  LockKeyhole,
  MessageSquare,
  Rocket,
  Sparkles,
  Star,
  Trophy,
  Users,
  Vote,
  Zap,
} from "lucide-react";
import type { ActivityItem, TokenSummary } from "../../shared/types.js";
import type { Tier } from "../../shared/economics.js";
import {
  formatCompact,
  formatPercent,
  formatPrice,
  formatTimeAgo,
  formatTokens,
  formatUsd,
  shortNumber,
} from "../../shared/format.js";
import { AssetLogo, Sparkline } from "./AssetLogo.js";
import { Badge, EmptyState, ProgressBar, Skeleton } from "./ui.js";

export function TierBadge({ tier, short = false }: { tier: Tier; short?: boolean }) {
  const label =
    tier === "seed" ? (short ? "Seed" : "Fresh gem") : tier === "rising" ? "Rising" : "Viral";
  return (
    <Badge tone={tier === "seed" ? "lime" : tier === "rising" ? "amber" : "red"} className="tier-badge">
      {tier === "seed" ? "●" : tier === "rising" ? "▲" : "◆"} {label}
    </Badge>
  );
}

export function VerificationBadge({
  verification,
  frozen,
  compact = false,
}: {
  verification: TokenSummary["verification"];
  frozen?: boolean;
  compact?: boolean;
}) {
  if (frozen || verification === "hidden") {
    return <Badge tone="red">{compact ? "Hidden" : "Unverified / hidden"}</Badge>;
  }
  if (verification === "verified") {
    return (
      <Badge tone="green" className="verified-badge">
        <BadgeCheck size={11} />
        {compact ? "Verified" : "README verified"}
      </Badge>
    );
  }
  return <Badge tone="outline">{compact ? "Community" : "Community indexed"}</Badge>;
}

export function Change({ bps, showIcon = true }: { bps: number; showIcon?: boolean }) {
  const positive = bps >= 0;
  return (
    <span className={clsx("change mono", positive ? "text-positive" : "text-negative")}>
      {showIcon ? positive ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} /> : null}
      {formatPercent(Math.abs(bps), { decimals: 1 })}
    </span>
  );
}

export function MarketTable({
  tokens,
  loading,
  emptyTitle = "No markets match this filter.",
  emptyBody = "Try a different tier or clear the search.",
  showProgress = true,
}: {
  tokens: TokenSummary[];
  loading?: boolean;
  emptyTitle?: string;
  emptyBody?: string;
  showProgress?: boolean;
}) {
  const navigate = useNavigate();
  if (loading) {
    return (
      <div className="market-table-wrap">
        {Array.from({ length: 7 }).map((_, index) => (
          <div className="market-row-skeleton" key={index}>
            <Skeleton style={{ width: 20 }} />
            <Skeleton className="skeleton-avatar" />
            <div className="market-skeleton-copy">
              <Skeleton style={{ width: `${150 + index * 24}px` }} />
              <Skeleton style={{ width: `${92 + index * 8}px`, height: 9 }} />
            </div>
            <Skeleton style={{ width: 62, marginLeft: "auto" }} />
            <Skeleton style={{ width: 56 }} />
            <Skeleton style={{ width: 74 }} />
            <Skeleton style={{ width: 100 }} />
          </div>
        ))}
      </div>
    );
  }
  if (!tokens.length) {
    return <EmptyState title={emptyTitle} body={emptyBody} icon={<GitBranch size={24} />} />;
  }
  return (
    <div className="market-table-wrap">
      <table className="market-table">
        <thead>
          <tr>
            <th className="col-rank">#</th>
            <th>Repository asset</th>
            <th className="col-tier">Tier</th>
            <th className="numeric">Price</th>
            <th className="numeric">24H</th>
            <th className="numeric col-fdv">FDV</th>
            <th className="numeric col-volume">24H VOL</th>
            {showProgress ? <th className="col-curve">Curve</th> : null}
            <th className="col-velocity">★ /H</th>
            <th className="col-action" />
          </tr>
        </thead>
        <tbody>
          {tokens.map((token, index) => (
            <tr
              key={token.id}
              className="market-row"
              onClick={() => navigate(`/real/${token.id}`)}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter") navigate(`/real/${token.id}`);
              }}
            >
              <td className="col-rank mono">{String(token.rank ?? index + 1).padStart(2, "0")}</td>
              <td>
                <div className="market-asset">
                  <AssetLogo src={token.logoUrl} ticker={token.ticker} size={35} />
                  <div className="market-asset-copy">
                    <div className="market-name">
                      <span className="market-ticker">${token.ticker}</span>
                      <span className="market-name-long">{token.name}</span>
                      {token.isKing ? (
                        <span className="king-mini" title="King of GitHub">
                          <Trophy size={10} />
                        </span>
                      ) : null}
                    </div>
                    <div className="market-repo mono">
                      <GitBranch size={10} />
                      {token.repo.fullName}
                      {token.verification === "verified" ? (
                        <BadgeCheck size={11} className="verified-inline" />
                      ) : null}
                    </div>
                  </div>
                </div>
              </td>
              <td className="col-tier"><TierBadge tier={token.tier} short /></td>
              <td className="numeric mono market-price">{formatPrice(token.priceMicro)}</td>
              <td className="numeric"><Change bps={token.change24hBps} /></td>
              <td className="numeric mono col-fdv">{formatUsd(token.marketCapMicro, { compact: true })}</td>
              <td className="numeric mono col-volume">
                {formatUsd(token.volume24hMicro, { compact: true })}
              </td>
              {showProgress ? (
                <td className="col-curve">
                  <div className="curve-cell">
                    <ProgressBar value={token.progressBps / 100} tone={token.tier === "viral" ? "red" : token.tier === "rising" ? "amber" : "lime"} />
                    <span className="mono">{formatPercent(token.progressBps, { decimals: 0 })}</span>
                  </div>
                </td>
              ) : null}
              <td className="col-velocity mono">
                <span className={token.repo.starVelocity1h > 0 ? "text-positive" : "muted"}>
                  +{token.repo.starVelocity1h}
                </span>
              </td>
              <td className="col-action">
                <span className="row-arrow"><ArrowUpRight size={14} /></span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FreshTokenCard({ token, index }: { token: TokenSummary; index: number }) {
  return (
    <Link to={`/real/${token.id}`} className="fresh-card">
      <div className="fresh-card-top">
        <span className="fresh-index mono">0{index + 1}</span>
        <TierBadge tier={token.tier} />
        <span className="fresh-stars mono">
          <Star size={11} /> {shortNumber(token.repo.stars)}
        </span>
      </div>
      <div className="fresh-card-asset">
        <AssetLogo src={token.logoUrl} ticker={token.ticker} size={44} />
        <div>
          <strong>${token.ticker}</strong>
          <span>{token.name}</span>
        </div>
        <Sparkline
          data={token.sparkline}
          width={70}
          height={30}
          positive={token.change24hBps >= 0}
          className="fresh-spark"
        />
      </div>
      <div className="fresh-card-repo mono">
        <GitBranch size={11} /> {token.repo.fullName}
      </div>
      <div className="fresh-card-stats">
        <div>
          <span>Price</span>
          <strong className="mono">{formatPrice(token.priceMicro)}</strong>
        </div>
        <div>
          <span>24h</span>
          <Change bps={token.change24hBps} />
        </div>
        <div>
          <span>FDV</span>
          <strong className="mono">{formatUsd(token.marketCapMicro, { compact: true })}</strong>
        </div>
      </div>
      <div className="fresh-curve">
        <div className="fresh-curve-label">
          <span>Curve progress</span>
          <span className="mono">{formatPercent(token.progressBps, { decimals: 0 })}</span>
        </div>
        <ProgressBar value={token.progressBps / 100} />
      </div>
    </Link>
  );
}

const ACTIVITY_ICONS: Record<string, React.ReactNode> = {
  trade: <CircleDollarSign size={13} />,
  launch: <Rocket size={13} />,
  verify: <BadgeCheck size={13} />,
  claim: <Award size={13} />,
  star: <Star size={13} />,
  graduation: <Sparkles size={13} />,
  stake: <LockKeyhole size={13} />,
  bounty: <GitCommitHorizontal size={13} />,
  dividend: <Zap size={13} />,
  vote: <Vote size={13} />,
};

export function ActivityFeed({
  items,
  loading,
  compact = false,
  limit,
  showHeader = true,
}: {
  items: ActivityItem[];
  loading?: boolean;
  compact?: boolean;
  limit?: number;
  showHeader?: boolean;
}) {
  const visible = limit ? items.slice(0, limit) : items;
  if (loading) {
    return (
      <div className={clsx("activity-feed", compact && "activity-feed-compact")}>
        {Array.from({ length: 6 }).map((_, index) => (
          <div className="activity-item" key={index}>
            <Skeleton className="activity-icon-skeleton" />
            <div className="activity-copy"><Skeleton style={{ width: "82%" }} /><Skeleton style={{ width: "44%" }} /></div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={clsx("activity-feed", compact && "activity-feed-compact")}>
      {showHeader && !compact ? (
        <div className="activity-head">
          <span>Live protocol activity</span>
          <span className="live-label"><span className="signal-dot" /> streaming</span>
        </div>
      ) : null}
      {visible.length === 0 ? (
        <p className="muted activity-empty">No activity yet.</p>
      ) : (
        visible.map((item) => (
          <div className="activity-item" key={item.id}>
            <span className={clsx("activity-icon", `activity-${item.type}`)}>
              {ACTIVITY_ICONS[item.type] ?? <GitBranch size={13} />}
            </span>
            <div className="activity-copy">
              <p>{item.message}</p>
              <div className="activity-meta mono">
                {item.tokenSlug ? (
                  <Link
                    to={item.tokenId ? `/real/${item.tokenId}` : `/token/${item.tokenSlug}`}
                    className="activity-ticker"
                  >
                    ${item.tokenTicker}
                  </Link>
                ) : null}
                {item.actor ? <span>{item.actor}</span> : null}
                <span>{formatTimeAgo(item.createdAt)}</span>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export function HolderAvatars({ token }: { token: TokenSummary }) {
  return (
    <span className="holder-inline mono">
      <Users size={12} /> {token.holderCount}
    </span>
  );
}

export function FlameBadge({ velocity }: { velocity: number }) {
  if (velocity <= 0) return null;
  return (
    <span className="flame-badge mono">
      <Flame size={11} /> {velocity}/h
    </span>
  );
}

export function ProgressSummary({ token }: { token: TokenSummary }) {
  return (
    <div className="progress-summary">
      <span className="mono">{formatTokens(token.progressBps)}</span>
      <span className="muted">to graduation</span>
    </div>
  );
}

export { formatCompact, formatUsd };
