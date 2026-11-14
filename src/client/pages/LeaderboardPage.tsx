import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUpRight,
  Crown,
  Medal,
  ShieldCheck,
  Sparkles,
  Trophy,
  X,
  Zap,
} from "lucide-react";
import clsx from "clsx";
import type { KingData, LeaderboardEntry } from "../../shared/types.js";
import { api } from "../lib/api.js";
import { formatCompact, formatUsd, truncateAddress } from "../../shared/format.js";
import { useAuth } from "../contexts/AuthContext.js";
import { AssetLogo } from "../components/AssetLogo.js";
import { Badge, buttonClass, Card, EmptyState, LiveDot, Skeleton } from "../components/ui.js";

interface LeaderboardResponse {
  traders: LeaderboardEntry[];
  chain: {
    valid: boolean;
    receipts: number;
    head: string | null;
    oraclePublicKey: string;
  };
}

export function LeaderboardPage() {
  const { user, openAuth } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["leaderboard"],
    queryFn: () => api<LeaderboardResponse>("/api/leaderboard"),
    staleTime: 15_000,
  });
  const { data: kingData } = useQuery({
    queryKey: ["king"],
    queryFn: () => api<{ king: KingData | null }>("/api/king"),
    staleTime: 15_000,
  });
  const top = data?.traders.slice(0, 3) ?? [];
  const rest = data?.traders.slice(3) ?? [];
  const king = kingData?.king;

  return (
    <div className="page leaderboard-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Reputation market</div>
          <h1 className="page-title">The sharpest<br /><em>books on GitFi.</em></h1>
          <p className="page-sub">XP is derived from real on-chain trade activity. No pay-to-win.</p>
        </div>
        <div className="leaderboard-head-side">
          <LiveDot label="ranking live" />
          <Link to={user ? "/portfolio" : "/explore"} className={buttonClass("secondary", "sm")}>
            {user ? "Your rank" : "Start trading"} <ArrowRight size={12} />
          </Link>
        </div>
      </div>

      {isLoading ? (
        <div className="leaderboard-grid">
          {Array.from({ length: 3 }).map((_, index) => <Skeleton key={index} style={{ height: 230 }} />)}
        </div>
      ) : data?.traders.length ? (
        <>
          <div className="podium-grid">
            {top.map((trader, index) => (
              <Card className={clsx("podium-card", `podium-${index + 1}`)} key={trader.address}>
                <div className="podium-rank mono">
                  {index === 0 ? <Crown size={18} /> : index === 1 ? <Medal size={17} /> : <Trophy size={16} />}
                  0{index + 1}
                </div>
                <div className="podium-avatar">{trader.displayName.slice(0, 2).toUpperCase()}</div>
                <div className="podium-name">
                  <strong>{trader.displayName}</strong>
                  {user?.address === trader.address ? <Badge tone="lime">YOU</Badge> : null}
                </div>
                <span className="mono podium-address">{truncateAddress(trader.address, 12, 6)}</span>
                <div className="podium-xp mono">{formatCompact(trader.xp)} <span>XP</span></div>
                <div className="podium-stats">
                  <div><span>PNL</span><strong className={trader.pnlMicro >= 0 ? "text-positive" : "text-negative"}>{formatUsd(trader.pnlMicro, { compact: true, sign: true })}</strong></div>
                  <div><span>TRADES</span><strong className="mono">{trader.trades}</strong></div>
                </div>
                {index === 0 ? <div className="podium-halo" aria-hidden="true" /> : null}
              </Card>
            ))}
          </div>

          <div className="leaderboard-body">
            <Card className="leaderboard-table-card">
              <div className="side-card-head">
                <span className="eyebrow">Full standings</span>
                <span className="mono">XP DESCENDING</span>
              </div>
              <div className="leaderboard-table">
                <div className="leaderboard-head mono">
                  <span>RANK</span><span>TRADER</span><span>XP</span><span>PNL</span><span>TRADES</span><span>WALLET</span>
                </div>
                {rest.length ? rest.map((trader) => (
                  <div className={clsx("leaderboard-row", user?.address === trader.address && "leaderboard-row-you")} key={trader.address}>
                    <span className="mono">{String(trader.rank).padStart(2, "0")}</span>
                    <div className="lb-trader">
                      <span className="lb-avatar">{trader.displayName.slice(0, 2).toUpperCase()}</span>
                      <strong>{trader.displayName}</strong>
                      {user?.address === trader.address ? <Badge tone="lime">YOU</Badge> : null}
                    </div>
                    <span className="mono">{formatCompact(trader.xp)}</span>
                    <span className={clsx("mono", trader.pnlMicro >= 0 ? "text-positive" : "text-negative")}>
                      {formatUsd(trader.pnlMicro, { compact: true, sign: true })}
                    </span>
                    <span className="mono">{trader.trades}</span>
                    <span className="mono muted">{truncateAddress(trader.address, 10, 4)}</span>
                  </div>
                )) : (
                  <EmptyState title="No leaders yet" body="Be the first to earn XP on the protocol." icon={<Trophy size={22} />} />
                )}
              </div>
            </Card>

            <aside className="leaderboard-side">
              {king ? (
                <Card className="king-side-card">
                  <div className="side-card-head">
                    <span className="eyebrow"><Crown size={12} /> King of GitHub</span>
                    <span className="mono side-badge">1H</span>
                  </div>
                  <Link to={`/real/${king.token.id}`} className="king-side-asset">
                    <AssetLogo src={king.token.logoUrl} ticker={king.token.ticker} size={42} />
                    <div><strong>${king.token.ticker}</strong><span>{king.token.repo.fullName}</span></div>
                    <ArrowUpRight size={14} />
                  </Link>
                  <div className="king-side-metrics">
                    <div><span>1H VOLUME</span><strong className="mono">{formatUsd(king.volume1hMicro)}</strong></div>
                    <div><span>STAR VELOCITY</span><strong className="mono">+{king.starVelocity1h}/h</strong></div>
                    <div><span>SCORE</span><strong className="mono">{formatCompact(king.score)}</strong></div>
                  </div>
                  <div className="king-side-note"><Zap size={12} /> Platform fee waived while reigning.</div>
                </Card>
              ) : null}
              <Card className="ledger-mini-card">
                <div className="side-card-head"><span className="eyebrow">Ledger integrity</span><ShieldCheck size={13} /></div>
                <div className={clsx("ledger-status", data?.chain.valid ? "valid" : "invalid")}>
                  <span className="signal-dot" />
                  {data?.chain.valid ? "Hash chain verified" : "Verification failed"}
                </div>
                <div className="ledger-mini-stats">
                  <div><span>RECEIPTS</span><strong className="mono">{data?.chain.receipts ?? 0}</strong></div>
                  <div><span>ORACLE</span><strong className="mono">ED25519</strong></div>
                </div>
                <Link to="/proof" className="card-footer-link">Inspect proof ledger <ArrowRight size={12} /></Link>
              </Card>
              <Card className="xp-card">
                <div className="side-card-head"><span className="eyebrow">How XP works</span><Sparkles size={13} /></div>
                <div className="xp-row"><span>Every $1 traded</span><strong className="mono">+10 XP</strong></div>
                <div className="xp-row"><span>Repo launch</span><strong className="mono">+500 XP</strong></div>
                <div className="xp-row"><span>Stake for 90d</span><strong className="mono">+400 XP</strong></div>
                <div className="xp-row"><span>Approved bounty</span><strong className="mono">+200 XP</strong></div>
                <p>XP is reputation, not a tradeable token.</p>
                {!user ? <button className={buttonClass("secondary", "sm", "full-width")} onClick={openAuth}>Start earning</button> : null}
              </Card>
            </aside>
          </div>
        </>
      ) : (
        <EmptyState title="Leaderboard is warming up" body="The first trades create the first rankings." icon={<Trophy size={24} />} action={<Link to="/explore" className={buttonClass("primary")}>Explore markets</Link>} />
      )}
    </div>
  );
}
