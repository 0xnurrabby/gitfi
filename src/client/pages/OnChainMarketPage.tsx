import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  Coins,
  ExternalLink,
  Gift,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  Trophy,
  Users,
  Wallet,
} from "lucide-react";
import clsx from "clsx";
import type { TokenDetail } from "../../shared/types.js";
import { formatPrice, formatTimeAgo, formatTokens, formatUsd } from "../../shared/format.js";
import { api, ApiRequestError } from "../lib/api.js";
import { smoothPath } from "../lib/chart.js";
import { useAuth } from "../contexts/AuthContext.js";
import { useToast } from "../contexts/ToastContext.js";
import { Badge, Button, Card, EmptyState, ProgressBar, Skeleton } from "../components/ui.js";
import { AssetLogo } from "../components/AssetLogo.js";
import { AiSummary } from "../components/Readme.js";

const YOCTO_PER_NEAR = 10n ** 24n;
const MICRO_PER_TOKEN = 1_000_000n;

interface OnChainTrade {
  id: string;
  tokenId: string;
  accountId: string;
  side: "buy" | "sell";
  nearAmount: string;
  tokenAmount: string;
  price: string;
  timestamp: string;
}

interface OnChainBounty {
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

interface OnChainMarketResponse {
  contractId: string;
  network: string;
  nearUsd: number;
  nearUsdSource: string;
  nearUsdUpdatedAt: number;
  market: {
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
  } | null;
  stats: {
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
  } | null;
  balance: string;
  cost: string;
  stake: string;
  pendingRewards: string;
  totalStaked: string;
  trades: OnChainTrade[];
  holders: Array<{ accountId: string; tokenAmount: string; shareBps: number }>;
  bounties: OnChainBounty[];
  chart: Array<{ time: number; price: number; kind: "launch" | "trade" | "current" }>;
}

function nearFromYocto(value: string | bigint, digits = 4): string {
  const raw = typeof value === "bigint" ? value : BigInt(value || "0");
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / YOCTO_PER_NEAR;
  const fraction = abs % YOCTO_PER_NEAR;
  const decimals = fraction.toString().padStart(24, "0").slice(0, digits).replace(/0+$/, "");
  if (whole === 0n && !decimals) return "0";
  return `${negative ? "-" : ""}${whole.toString()}${decimals ? `.${decimals}` : ""}`;
}

function tokensFromMicro(value: string | bigint, digits = 2): string {
  const raw = typeof value === "bigint" ? value : BigInt(value || "0");
  const whole = raw / MICRO_PER_TOKEN;
  const fraction = raw % MICRO_PER_TOKEN;
  const decimals = fraction.toString().padStart(6, "0").slice(0, digits).replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${decimals ? `.${decimals}` : ""}`;
}

function parseNear(value: string): bigint {
  if (!/^\d*\.?\d*$/.test(value) || !value || value === ".") return 0n;
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole || "0") * YOCTO_PER_NEAR + BigInt((fraction + "0".repeat(24)).slice(0, 24));
}

function parseTokens(value: string): bigint {
  if (!/^\d*\.?\d*$/.test(value) || !value || value === ".") return 0n;
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole || "0") * MICRO_PER_TOKEN + BigInt((fraction + "0".repeat(6)).slice(0, 6));
}

function usdMicroFromYocto(yocto: bigint, nearUsd: number): number {
  if (nearUsd <= 0) return 0;
  return Number((yocto * BigInt(Math.round(nearUsd * 1_000_000))) / YOCTO_PER_NEAR);
}

function usdPriceFromMarketPrice(priceYoctoPerMicro: bigint, nearUsd: number): number {
  // price is yoctoNEAR per micro-token; convert to USD per whole token, in micro-USD.
  return Math.round((Number(priceYoctoPerMicro) * nearUsd * 1_000_000) / 1e18);
}

function usdPriceFromWholeYocto(priceYoctoPerToken: bigint, nearUsd: number): number {
  return Math.round((Number(priceYoctoPerToken) * nearUsd * 1_000_000) / 1e24);
}

function shortAddress(address: string): string {
  return address.length > 20 ? `${address.slice(0, 9)}…${address.slice(-5)}` : address;
}

export function OnChainMarketPage() {
  const { id } = useParams();
  const { user, nearWallet, openAuth } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [stakeAmount, setStakeAmount] = useState("");
  const [tab, setTab] = useState<"activity" | "holders" | "bounties">("activity");
  const [bountyTitle, setBountyTitle] = useState("");
  const [bountyDescription, setBountyDescription] = useState("");
  const [bountyReward, setBountyReward] = useState("0.1");
  const [winner, setWinner] = useState<Record<string, string>>({});

  const tokenQuery = useQuery({
    queryKey: ["token", id],
    queryFn: () => api<TokenDetail>(`/api/tokens/${id}`),
    enabled: Boolean(id),
  });
  const marketQuery = useQuery({
    queryKey: ["onchain", "market", id, user?.address],
    queryFn: () => api<OnChainMarketResponse>(`/api/onchain/market/${id}`),
    enabled: Boolean(id),
    refetchInterval: 15_000,
  });

  const token = tokenQuery.data;
  const data = marketQuery.data;
  const market = data?.market;
  const stats = data?.stats;
  const nearUsd = data?.nearUsd ?? 0;
  const isMainnet = data?.network === "mainnet";
  const explorerOrigin = isMainnet ? "https://explorer.near.org" : "https://explorer.testnet.near.org";

  useEffect(() => {
    if (token) document.title = `${token.name} ($${token.ticker}) - GitFi.fun`;
  }, [token]);

  const chart = useMemo(() => {
    const points = [...(data?.chart ?? [])].sort((a, b) => a.time - b.time);
    if (!points.length) return null;
    const visible = points.length === 1 ? [points[0]!, points[0]!] : points;
    const width = 920;
    const height = 290;
    const padX = 18;
    const padY = 18;
    const prices = visible.map((point) =>
      nearUsd > 0 ? (point.price * nearUsd) / 1e18 : point.price / 1e18,
    );
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = Math.max(max - min, Math.max(max, 1e-18) * 0.04);
    const start = visible[0]!.time;
    const end = visible[visible.length - 1]!.time;
    const timeSpan = Math.max(1, end - start);
    const plotted = prices.map((price, index) => ({
      x:
        padX +
        (points.length === 1 ? 0.5 : (visible[index]!.time - start) / timeSpan) * (width - padX * 2),
      y: padY + (1 - (price - min) / span) * (height - padY * 2),
    }));
    const line = smoothPath(plotted);
    const area = `${line} L ${plotted[plotted.length - 1]!.x} ${height} L ${plotted[0]!.x} ${height} Z`;
    return {
      width,
      height,
      line,
      area,
      points: plotted,
      first: prices[0]!,
      last: prices[prices.length - 1]!,
      start: visible[0]!.time,
      end: visible[visible.length - 1]!.time,
    };
  }, [data?.chart, nearUsd]);

  const buyAmount = parseNear(amount);
  const sellAmount = parseTokens(amount);
  const feeBps = 130n;
  const price = market ? BigInt(market.price || "0") : 0n;
  const buyQuote = price > 0n ? (buyAmount * (10_000n - feeBps)) / 10_000n / price : 0n;
  const sellQuote = market ? (sellAmount * price * (10_000n - feeBps)) / 10_000n : 0n;
  const quote = side === "buy" ? buyQuote : sellQuote;
  const quoteUsd =
    side === "buy"
      ? usdMicroFromYocto((buyAmount * 9870n) / 10_000n, nearUsd)
      : usdMicroFromYocto(sellQuote, nearUsd);

  const signAndSend = async (
    methodName: string,
    args: Record<string, unknown>,
    deposit = 0n,
  ) => {
    if (!nearWallet || !user || !data) {
      throw new ApiRequestError("Connect your NEAR wallet first.", 401, "AUTH_REQUIRED");
    }
    const accounts = await nearWallet.getAccounts({
      network: data.network === "mainnet" ? "mainnet" : "testnet",
    });
    const signerId = accounts[0]?.accountId ?? user.address;
    return nearWallet.signAndSendTransaction({
      receiverId: data.contractId,
      signerId,
      actions: [
        {
          type: "FunctionCall" as const,
          params: {
            methodName,
            args,
            gas: "100000000000000",
            deposit: deposit.toString(),
          },
        },
      ],
    });
  };

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["onchain", "market", id] });
    queryClient.invalidateQueries({ queryKey: ["portfolio"] });
    queryClient.invalidateQueries({ queryKey: ["home"] });
    queryClient.invalidateQueries({ queryKey: ["explore"] });
  };

  const tradeMutation = useMutation({
    mutationFn: async () => {
      if (!market) throw new Error("Market is not live.");
      if (side === "buy") {
        return signAndSend(
          "buy",
          {
            token_id: market.tokenId,
            min_tokens: ((buyQuote * 995n) / 1000n).toString(),
          },
          buyAmount,
        );
      }
      return signAndSend("sell", {
        token_id: market.tokenId,
        token_amount: sellAmount.toString(),
        min_near: ((sellQuote * 995n) / 1000n).toString(),
      });
    },
    onSuccess: () => {
      setAmount("");
      refresh();
      notify(
        side === "buy"
          ? "On-chain buy confirmed by the market contract."
          : "On-chain sell confirmed by the market contract.",
        { kind: "success", title: isMainnet ? "Mainnet transaction" : "Testnet transaction" },
      );
    },
    onError: (error) =>
      notify(error instanceof Error ? error.message : "On-chain trade failed.", {
        kind: "error",
        title: "No funds moved",
      }),
  });

  const stakeMutation = useMutation({
    mutationFn: async (kind: "stake" | "unstake" | "claim") => {
      if (!market) throw new Error("Market is not live.");
      if (kind === "claim") {
        return signAndSend("claim_staking_rewards", { token_id: market.tokenId });
      }
      return signAndSend(kind, {
        token_id: market.tokenId,
        token_amount: parseTokens(stakeAmount).toString(),
      });
    },
    onSuccess: (_result, kind) => {
      if (kind !== "claim") setStakeAmount("");
      refresh();
      notify(
        kind === "stake"
          ? "Tokens staked on-chain. You now earn a share of trade fees."
          : kind === "unstake"
            ? "Tokens unstaked and returned to your trading balance."
            : "Staking rewards claimed in NEAR.",
        { kind: "success", title: "On-chain staking" },
      );
    },
    onError: (error) =>
      notify(error instanceof Error ? error.message : "Staking transaction failed.", {
        kind: "error",
      }),
  });

  const bountyMutation = useMutation({
    mutationFn: async ({ kind, bounty }: { kind: "create" | "approve" | "cancel"; bounty?: OnChainBounty }) => {
      if (!market) throw new Error("Market is not live.");
      if (kind === "create") {
        return signAndSend(
          "create_bounty",
          {
            token_id: market.tokenId,
            title: bountyTitle.trim(),
            description: bountyDescription.trim(),
          },
          parseNear(bountyReward),
        );
      }
      if (!bounty) throw new Error("Bounty missing.");
      if (kind === "cancel") {
        return signAndSend("cancel_bounty", { bounty_id: Number(bounty.id) });
      }
      const winnerId = (winner[bounty.id] ?? "").trim();
      if (!winnerId) throw new Error("Enter the winner's NEAR account.");
      return signAndSend("approve_bounty", {
        bounty_id: Number(bounty.id),
        winner: winnerId,
      });
    },
    onSuccess: (_result, { kind }) => {
      if (kind === "create") {
        setBountyTitle("");
        setBountyDescription("");
        setBountyReward("0.1");
      }
      refresh();
      notify(
        kind === "create"
          ? "Bounty funded on-chain in NEAR escrow."
          : kind === "approve"
            ? "Bounty paid to the winner in NEAR."
            : "Bounty cancelled and escrow refunded.",
        { kind: "success", title: "On-chain bounty" },
      );
    },
    onError: (error) =>
      notify(error instanceof Error ? error.message : "Bounty transaction failed.", {
        kind: "error",
      }),
  });

  if (tokenQuery.isLoading || marketQuery.isLoading) {
    return (
      <div className="page onchain-page">
        <Skeleton style={{ height: 90 }} />
        <Skeleton style={{ height: 360, marginTop: 18 }} />
      </div>
    );
  }

  if (!token || !market || !data || !stats) {
    return (
      <div className="page">
        <EmptyState
          title="On-chain market not live"
          body="This market has no deployed NEAR contract yet."
          icon={<ShieldCheck size={24} />}
          action={
            <Link to="/explore" className="btn btn-primary btn-md">
              Browse live markets
            </Link>
          }
        />
      </div>
    );
  }

  const balance = BigInt(data.balance || "0");
  const stake = BigInt(data.stake || "0");
  const cost = BigInt(data.cost || "0");
  const pending = BigInt(data.pendingRewards || "0");
  const value = (balance + stake) * price;
  const valueUsd = usdMicroFromYocto(value, nearUsd);
  const costUsd = usdMicroFromYocto(cost, nearUsd);
  const pnlUsd = valueUsd - costUsd;
  const pnlBps = costUsd > 0 ? Math.round((pnlUsd * 10_000) / costUsd) : 0;
  const avgEntry = balance + stake > 0n ? (cost * MICRO_PER_TOKEN) / (balance + stake) : 0n;
  const up = (chart?.last ?? 0) >= (chart?.first ?? 0);
  const disabled =
    side === "buy"
      ? buyAmount <= 0n
      : sellAmount <= 0n || sellAmount > balance;
  const isOwner = market.owner === user?.address;
  const canStake = Boolean(user && nearWallet);

  return (
    <div className="page onchain-page">
      <div className="onchain-head">
        <div className="onchain-identity">
          <AssetLogo src={token.logoUrl} ticker={token.ticker} size={58} />
          <div>
            <div className="onchain-title">
              <h1>${token.ticker}</h1>
              <Badge tone="green">
                <BadgeCheck size={11} /> ON-CHAIN
              </Badge>
              <Badge tone="amber">
                {market.status === "graduated" ? "GRADUATED" : "BONDING"}
              </Badge>
            </div>
            <span className="mono muted">{market.repo}</span>
            {token.launchMarketCapMicro ? (
              <span className="mono muted" style={{ display: "block", marginTop: 4 }}>
                Launch {formatUsd(token.launchMarketCapMicro)} · {token.launchStars ?? 0} stars
              </span>
            ) : null}
          </div>
        </div>
        <div className="onchain-contract">
          <span className="mono">
            NEAR {isMainnet ? "MAINNET" : "TESTNET"} · LIVE NEAR ${nearUsd ? nearUsd.toFixed(3) : "—"}
          </span>
          <a
            href={`${explorerOrigin}/accounts/${data.contractId}`}
            target="_blank"
            rel="noreferrer"
            className="text-link mono"
          >
            {data.contractId} <ExternalLink size={11} />
          </a>
        </div>
      </div>

      <div className="onchain-grid">
        <div className="onchain-main">
          <Card className="onchain-chart-card">
            <div className="onchain-chart-head">
              <div>
                <span className="eyebrow">Real on-chain price · USD</span>
                <strong className="mono onchain-price">{formatPrice(stats.priceUsdMicro)}</strong>
                <span className="mono onchain-subprice">{nearFromYocto(stats.priceNear, 9)} NEAR</span>
                <span
                  className={clsx(
                    "mono onchain-change",
                    stats.change24hBps >= 0 ? "text-positive" : "text-negative",
                  )}
                >
                  {stats.change24hBps >= 0 ? "+" : ""}
                  {(stats.change24hBps / 100).toFixed(2)}% 24H
                </span>
              </div>
              <a
                href={`${explorerOrigin}/accounts/${data.contractId}`}
                target="_blank"
                rel="noreferrer"
                className="text-link mono"
              >
                Contract <ExternalLink size={11} />
              </a>
            </div>
            <svg
              viewBox={`0 0 ${chart?.width ?? 920} ${chart?.height ?? 290}`}
              className="onchain-chart"
              role="img"
              aria-label={`${token.ticker} on-chain price in USD`}
            >
              <defs>
                <linearGradient id="onchain-area" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor={up ? "var(--positive)" : "var(--negative)"}
                    stopOpacity="0.22"
                  />
                  <stop
                    offset="100%"
                    stopColor={up ? "var(--positive)" : "var(--negative)"}
                    stopOpacity="0"
                  />
                </linearGradient>
              </defs>
              {[0.25, 0.5, 0.75].map((ratio) => (
                <line
                  key={ratio}
                  x1="18"
                  x2="902"
                  y1={18 + ratio * 254}
                  y2={18 + ratio * 254}
                  stroke="var(--line-soft)"
                  strokeWidth="1"
                />
              ))}
              {chart ? (
                <>
                  <path d={chart.area} fill="url(#onchain-area)" />
                  <path
                    d={chart.line}
                    fill="none"
                    stroke={up ? "var(--positive)" : "var(--negative)"}
                    strokeWidth="2.2"
                  />
                  <circle
                    cx={chart.points[chart.points.length - 1]!.x}
                    cy={chart.points[chart.points.length - 1]!.y}
                    r="4"
                    fill={up ? "var(--positive)" : "var(--negative)"}
                  />
                </>
              ) : null}
            </svg>
            <div className="onchain-chart-foot mono">
              <span>
                {stats.tradeCount} ON-CHAIN {stats.tradeCount === 1 ? "TRADE" : "TRADES"}
                {stats.tradeCount === 0 ? " · LAUNCH PRICE UNTIL FIRST BUY" : ""}
              </span>
              <span>
                {chart
                  ? `${new Date(chart.start).toLocaleDateString("en-US", { month: "short", day: "numeric" })} → NOW`
                  : "PRICE IN USD"}
              </span>
            </div>
          </Card>

          <div className="onchain-stats">
            <div>
              <span>MARKET CAP</span>
              <strong className="mono">{formatUsd(stats.marketCapUsdMicro, { compact: true })}</strong>
              <em className="mono">{nearFromYocto(stats.marketCapNear, 1)} NEAR</em>
            </div>
            <div>
              <span>24H VOLUME</span>
              <strong className="mono">{formatUsd(stats.volume24hUsdMicro, { compact: true })}</strong>
              <em className="mono">{nearFromYocto(stats.volume24hNear, 3)} NEAR</em>
            </div>
            <div>
              <span>LIQUIDITY</span>
              <strong className="mono">{nearFromYocto(market.reserve, 2)} NEAR</strong>
              <em className="mono">{formatUsd(usdMicroFromYocto(BigInt(market.reserve), nearUsd), { compact: true })}</em>
            </div>
            <div>
              <span>HOLDERS</span>
              <strong className="mono">{stats.holderCount}</strong>
              <em className="mono">{nearFromYocto(data.totalStaked, 2)} NEAR STAKED</em>
            </div>
          </div>

          <Card className="onchain-position">
            <div className="side-card-head">
              <span className="eyebrow">
                <Wallet size={12} /> Your on-chain position
              </span>
              <span className="mono">{user ? user.address : "not connected"}</span>
            </div>
            <div className="onchain-position-grid">
              <div>
                <span>BALANCE</span>
                <strong className="mono">
                  {tokensFromMicro(balance, 2)} {market.ticker}
                </strong>
                <em className="mono">{tokensFromMicro(stake, 2)} staked</em>
              </div>
              <div>
                <span>AVG ENTRY</span>
                <strong className="mono">{formatPrice(usdPriceFromWholeYocto(avgEntry, nearUsd))}</strong>
                <em className="mono">{nearFromYocto(avgEntry, 9)} NEAR</em>
              </div>
              <div>
                <span>VALUE</span>
                <strong className="mono">{formatUsd(valueUsd)}</strong>
                <em className="mono">{nearFromYocto(value, 4)} NEAR</em>
              </div>
              <div>
                <span>P&L</span>
                <strong className={clsx("mono", pnlUsd >= 0 ? "text-positive" : "text-negative")}>
                  {formatUsd(pnlUsd, { sign: true })}
                </strong>
                <em className={clsx("mono", pnlUsd >= 0 ? "text-positive" : "text-negative")}>
                  {pnlBps >= 0 ? "+" : ""}
                  {(pnlBps / 100).toFixed(2)}% incl. fees
                </em>
              </div>
            </div>
            {user ? (
              <div className="onchain-progress">
                <div className="onchain-progress-label mono">
                  <span>BONDING CURVE</span>
                  <span>{formatTokens(BigInt(market.sold), { compact: true })} SOLD · {(stats.progressBps / 100).toFixed(1)}%</span>
                </div>
                <ProgressBar value={stats.progressBps / 100} tone="lime" />
              </div>
            ) : null}
          </Card>

          <Card className="onchain-staking">
            <div className="side-card-head">
              <span className="eyebrow">
                <Coins size={12} /> Stake for fee yield
              </span>
              <span className="mono text-positive">
                {formatUsd(usdMicroFromYocto(pending, nearUsd))} CLAIMABLE
              </span>
            </div>
            <div className="onchain-staking-grid">
              <div>
                <span>TOTAL STAKED</span>
                <strong className="mono">
                  {tokensFromMicro(data.totalStaked, 0)} {market.ticker}
                </strong>
              </div>
              <div>
                <span>YOUR STAKE</span>
                <strong className="mono">
                  {tokensFromMicro(stake, 2)} {market.ticker}
                </strong>
              </div>
              <div>
                <span>REWARD POOL</span>
                <strong className="mono">0.5% of every trade</strong>
              </div>
            </div>
            {canStake ? (
              <div className="onchain-stake-actions">
                <label className="onchain-input">
                  <span>STAKE / UNSTAKE {market.ticker}</span>
                  <div>
                    <input
                      value={stakeAmount}
                      onChange={(event) => {
                        if (/^\d*\.?\d*$/.test(event.target.value)) setStakeAmount(event.target.value);
                      }}
                      placeholder="0.00"
                      inputMode="decimal"
                    />
                    <em>{market.ticker}</em>
                  </div>
                  <small className="mono">
                    Available {tokensFromMicro(balance, 2)} · Staked {tokensFromMicro(stake, 2)}
                  </small>
                </label>
                <div className="onchain-stake-buttons">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => stakeMutation.mutate("stake")}
                    loading={stakeMutation.isPending && stakeMutation.variables === "stake"}
                    disabled={parseTokens(stakeAmount) <= 0n || parseTokens(stakeAmount) > balance}
                  >
                    Stake
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => stakeMutation.mutate("unstake")}
                    loading={stakeMutation.isPending && stakeMutation.variables === "unstake"}
                    disabled={parseTokens(stakeAmount) <= 0n || parseTokens(stakeAmount) > stake}
                  >
                    Unstake
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => stakeMutation.mutate("claim")}
                    loading={stakeMutation.isPending && stakeMutation.variables === "claim"}
                    disabled={pending <= 0n}
                    icon={<LockKeyhole size={12} />}
                  >
                    Claim {formatUsd(usdMicroFromYocto(pending, nearUsd))}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="onchain-note">Connect your NEAR wallet to stake and claim fee yield.</p>
            )}
          </Card>

          <div className="onchain-below">
            <AiSummary token={token} />
          </div>
        </div>

        <Card className="onchain-trade">
          <div className="side-card-head">
            <span className="eyebrow">Execute on NEAR</span>
            <span className="mono">{isMainnet ? "LIVE MAINNET" : "LIVE TESTNET"}</span>
          </div>
          <div className="onchain-toggle">
            <button
              className={side === "buy" ? "active" : ""}
              onClick={() => {
                setSide("buy");
                setAmount("");
              }}
            >
              <ArrowUp size={14} /> Buy
            </button>
            <button
              className={side === "sell" ? "active" : ""}
              onClick={() => {
                setSide("sell");
                setAmount("");
              }}
            >
              <ArrowDown size={14} /> Sell
            </button>
          </div>

          <label className="onchain-input">
            <span>{side === "buy" ? "YOU PAY" : "YOU SELL"}</span>
            <div>
              <input
                value={amount}
                onChange={(event) => {
                  if (/^\d*\.?\d*$/.test(event.target.value)) setAmount(event.target.value);
                }}
                placeholder="0.00"
                inputMode="decimal"
              />
              <em>{side === "buy" ? "NEAR" : market.ticker}</em>
            </div>
            <small className="mono">
              {side === "buy"
                ? `≈ ${formatUsd(usdMicroFromYocto(buyAmount, nearUsd))}`
                : `Available ${tokensFromMicro(balance, 2)} ${market.ticker}`}
            </small>
          </label>

          <div className="onchain-quote">
            <span>{side === "buy" ? "You receive" : "You receive"}</span>
            <strong className="mono">
              {side === "buy"
                ? `${tokensFromMicro(quote, 2)} ${market.ticker}`
                : `${nearFromYocto(quote, 6)} NEAR`}
            </strong>
          </div>
          <div className="onchain-quote onchain-quote-sub">
            <span>Value</span>
            <strong className="mono">{formatUsd(quoteUsd)}</strong>
          </div>

          {!nearWallet ? (
            <Button
              size="lg"
              variant="primary"
              className="full-width"
              onClick={openAuth}
              icon={<Wallet size={15} />}
            >
              Connect NEAR wallet
            </Button>
          ) : (
            <Button
              size="lg"
              variant={side === "buy" ? "primary" : "danger"}
              className="full-width"
              onClick={() => tradeMutation.mutate()}
              loading={tradeMutation.isPending}
              disabled={disabled}
            >
              {side === "buy" ? `Buy ${market.ticker}` : `Sell ${market.ticker}`}
            </Button>
          )}

          <p className="onchain-note">
            Wallet-signed and settled by the market contract. 1.3% fee: 0.5%
            creator, 0.3% team, 0.5% stakers. Prices are displayed in USD using live NEAR/USD.
          </p>
        </Card>
      </div>

      <section className="onchain-community">
        <div className="onchain-community-head">
          <div>
            <span className="eyebrow">On-chain records</span>
            <h2>Every fill, holder and bounty.</h2>
          </div>
          <div className="onchain-community-meta mono">
            <span>
              <Users size={12} /> {stats.holderCount} HOLDERS
            </span>
            <span>
              <Trophy size={12} /> {nearFromYocto(stats.volumeTotalNear, 2)} NEAR VOLUME
            </span>
          </div>
        </div>
        <div className="onchain-tabs">
          <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>
            Live activity
          </button>
          <button className={tab === "holders" ? "active" : ""} onClick={() => setTab("holders")}>
            Holders
          </button>
          <button className={tab === "bounties" ? "active" : ""} onClick={() => setTab("bounties")}>
            Bounties <span>{data.bounties.filter((bounty) => bounty.status === "open").length}</span>
          </button>
        </div>

        {tab === "activity" ? (
          <Card className="onchain-table">
            {data.trades.length ? (
              data.trades.map((trade) => {
                const nearValue = BigInt(trade.nearAmount || "0");
                const tokenValue = BigInt(trade.tokenAmount || "0");
                return (
                  <div className="onchain-row" key={trade.id}>
                    <span className={clsx("onchain-side", trade.side)}>{trade.side}</span>
                    <span className="mono onchain-actor">{shortAddress(trade.accountId)}</span>
                    <span className="mono">
                      {tokensFromMicro(tokenValue, 2)} {market.ticker}
                    </span>
                    <span className="mono">{nearFromYocto(nearValue, 4)} NEAR</span>
                    <span className="mono">{formatUsd(usdMicroFromYocto(nearValue, nearUsd))}</span>
                    <span className="mono muted">{formatTimeAgo(new Date(Number(BigInt(trade.timestamp) / 1_000_000n)))}</span>
                  </div>
                );
              })
            ) : (
              <div className="onchain-empty-row">
                No on-chain trades yet. The launch price is live and the first buy will appear here.
              </div>
            )}
          </Card>
        ) : null}

        {tab === "holders" ? (
          <Card className="onchain-table">
            {data.holders.length ? (
              data.holders.slice(0, 20).map((holder, index) => (
                <div className="onchain-row onchain-holder-row" key={holder.accountId}>
                  <span className="mono muted">{String(index + 1).padStart(2, "0")}</span>
                  <span className="mono onchain-actor">{shortAddress(holder.accountId)}</span>
                  <span className="mono">
                    {tokensFromMicro(holder.tokenAmount, 2)} {market.ticker}
                  </span>
                  <span className="mono">{(holder.shareBps / 100).toFixed(2)}%</span>
                  <span className="mono muted">
                    {formatUsd(
                      usdMicroFromYocto(BigInt(holder.tokenAmount) * price, nearUsd),
                    )}
                  </span>
                  {user?.address === holder.accountId ? <Badge tone="green">YOU</Badge> : <span />}
                </div>
              ))
            ) : (
              <div className="onchain-empty-row">No holders yet.</div>
            )}
          </Card>
        ) : null}

        {tab === "bounties" ? (
          <div className="onchain-bounties">
            <Card className="onchain-table">
              {data.bounties.length ? (
                data.bounties.map((bounty) => (
                  <div className="onchain-bounty" key={bounty.id}>
                    <div className="onchain-bounty-main">
                      <div className="onchain-bounty-title">
                        <strong>{bounty.title}</strong>
                        <Badge tone={bounty.status === "open" ? "green" : bounty.status === "paid" ? "outline" : "red"}>
                          {bounty.status.toUpperCase()}
                        </Badge>
                      </div>
                      <p>{bounty.description || "No description."}</p>
                      <span className="mono muted">
                        {formatUsd(usdMicroFromYocto(BigInt(bounty.reward), nearUsd))} escrow ·{" "}
                        {shortAddress(bounty.creator)} · {formatTimeAgo(new Date(Number(BigInt(bounty.createdAt) / 1_000_000n)))}
                      </span>
                    </div>
                    {bounty.status === "open" && isOwner ? (
                      <div className="onchain-bounty-actions">
                        <input
                          value={winner[bounty.id] ?? ""}
                          onChange={(event) =>
                            setWinner((current) => ({ ...current, [bounty.id]: event.target.value }))
                          }
                          placeholder="winner.near"
                          className="onchain-mini-input mono"
                        />
                        <Button
                          size="xs"
                          variant="primary"
                          onClick={() => bountyMutation.mutate({ kind: "approve", bounty })}
                          loading={bountyMutation.isPending}
                        >
                          Pay
                        </Button>
                      </div>
                    ) : null}
                    {bounty.status === "open" && user?.address === bounty.creator ? (
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => bountyMutation.mutate({ kind: "cancel", bounty })}
                        loading={bountyMutation.isPending}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="onchain-empty-row">No bounties yet.</div>
              )}
            </Card>

            {user ? (
              <Card className="onchain-bounty-create">
                <div className="side-card-head">
                  <span className="eyebrow">
                    <Gift size={12} /> Fund an on-chain bounty
                  </span>
                  <span className="mono">NEAR ESCROW</span>
                </div>
                <label className="onchain-input">
                  <span>TITLE</span>
                  <div>
                    <input
                      value={bountyTitle}
                      onChange={(event) => setBountyTitle(event.target.value)}
                      placeholder="Ship the feature"
                      maxLength={120}
                    />
                  </div>
                </label>
                <label className="onchain-input">
                  <span>DESCRIPTION</span>
                  <div>
                    <input
                      value={bountyDescription}
                      onChange={(event) => setBountyDescription(event.target.value)}
                      placeholder="What should be delivered?"
                      maxLength={600}
                    />
                  </div>
                </label>
                <label className="onchain-input">
                  <span>REWARD (NEAR)</span>
                  <div>
                    <input
                      value={bountyReward}
                      onChange={(event) => {
                        if (/^\d*\.?\d*$/.test(event.target.value)) setBountyReward(event.target.value);
                      }}
                      inputMode="decimal"
                    />
                    <em>NEAR</em>
                  </div>
                  <small className="mono">≈ {formatUsd(usdMicroFromYocto(parseNear(bountyReward), nearUsd))}</small>
                </label>
                <Button
                  variant="primary"
                  className="full-width"
                  onClick={() => bountyMutation.mutate({ kind: "create" })}
                  loading={bountyMutation.isPending}
                  disabled={!bountyTitle.trim() || parseNear(bountyReward) <= 0n}
                  icon={<Sparkles size={14} />}
                >
                  Fund bounty
                </Button>
                <p className="onchain-note">
                  Your NEAR is escrowed in the market contract. The repo owner approves the
                  winner; otherwise you can cancel and get the full refund.
                </p>
              </Card>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
