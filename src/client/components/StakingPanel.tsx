import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Coins,
  Info,
  LockKeyhole,
  Percent,
  Sparkles,
  Timer,
} from "lucide-react";
import clsx from "clsx";
import type { TokenDetail, UserProfile } from "../../shared/types.js";
import { api, ApiRequestError } from "../lib/api.js";
import { formatPercent, formatTokens, formatUsd } from "../../shared/format.js";
import { useAuth } from "../contexts/AuthContext.js";
import { useToast } from "../contexts/ToastContext.js";
import { Button, Card, ProgressBar } from "./ui.js";

const LOCKS = [
  { days: 7, multiplier: "1.0×", note: "flexible" },
  { days: 30, multiplier: "1.25×", note: "balanced" },
  { days: 90, multiplier: "1.5×", note: "max XP" },
];

export function StakingPanel({ token }: { token: TokenDetail }) {
  const { user, openAuth, setUser } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("");
  const [lockDays, setLockDays] = useState<7 | 30 | 90>(30);

  const stake = token.myStake;
  const holding = token.myHolding;
  const freeTokens = holding
    ? Math.max(0, holding.amountMicro - holding.stakedMicro - holding.vestedMicro)
    : 0;
  const pending = token.myDividendsMicro;
  const amountMicro = Math.floor((Number.parseFloat(amount) || 0) * 1_000_000);

  const refresh = (freshUser?: UserProfile) => {
    if (freshUser) setUser(freshUser);
    queryClient.invalidateQueries({ queryKey: ["token"] });
    queryClient.invalidateQueries({ queryKey: ["portfolio"] });
    queryClient.invalidateQueries({ queryKey: ["home"] });
  };

  const stakeMutation = useMutation({
    mutationFn: () =>
      api<{ user: UserProfile }>(`/api/tokens/${token.id}/stake`, {
        method: "POST",
        body: { amountMicro, lockDays },
      }),
    onSuccess: (result) => {
      setAmount("");
      refresh(result.user);
      notify(`Tokens locked for ${lockDays} days. Dividends accrue as the market trades.`, {
        kind: "success",
        title: "Stake active",
      });
    },
    onError: (error) => {
      notify(error instanceof ApiRequestError ? error.message : "Stake failed.", { kind: "error" });
    },
  });

  const unstakeMutation = useMutation({
    mutationFn: () =>
      api<{ user: UserProfile }>(`/api/tokens/${token.id}/unstake`, {
        method: "POST",
        body: { amountMicro: stake?.amountMicro ?? 0 },
      }),
    onSuccess: (result) => {
      refresh(result.user);
      notify("Stake unlocked. Tokens are available to trade.", { kind: "success" });
    },
    onError: (error) => {
      notify(error instanceof ApiRequestError ? error.message : "Unstake failed.", { kind: "error" });
    },
  });

  const claimMutation = useMutation({
    mutationFn: () => api<{ user: UserProfile; amountMicro: number }>("/api/claim", { method: "POST" }),
    onSuccess: (result) => {
      refresh(result.user);
      notify(`Claimed ${formatUsd(result.amountMicro)} across protocol earnings.`, {
        kind: "success",
        title: "Yield claimed",
      });
    },
    onError: (error) => {
      notify(error instanceof ApiRequestError ? error.message : "Nothing to claim yet.", {
        kind: "error",
      });
    },
  });

  const unlockDate = stake ? new Date(stake.unlockAt) : null;
  const locked = unlockDate ? unlockDate.getTime() > Date.now() : false;
  const stakedShare = useMemo(() => {
    if (!token.circulation.totalSupplyMicro) return 0;
    return Math.round((token.totalStakedMicro / token.circulation.totalSupplyMicro) * 10_000);
  }, [token.circulation.totalSupplyMicro, token.totalStakedMicro]);

  return (
    <Card className="staking-card">
      <div className="side-card-head">
        <span className="eyebrow"><Coins size={12} /> Holder yield</span>
        <span className="mono side-badge">REAL FEES</span>
      </div>
      <div className="staking-heading">
        <h3>Lock ${token.ticker}. <em>Earn the fee.</em></h3>
        <p>20% of protocol fees are recycled to staked holders, proportional to your lock.</p>      </div>
      <div className="staking-metrics">
        <div>
          <span>YOUR PENDING</span>
          <strong className="mono">{user ? formatUsd(pending) : "—"}</strong>
        </div>
        <div>
          <span>POOL STAKED</span>
          <strong className="mono">{formatUsd((token.totalStakedMicro * token.priceMicro) / 1_000_000)}</strong>
        </div>
        <div>
          <span>STAKED SHARE</span>
          <strong className="mono">{formatPercent(stakedShare)}</strong>
        </div>
      </div>
      <div className="staking-bar">
        <ProgressBar value={Math.min(100, stakedShare / 5)} tone="lime" />
        <span className="mono">{formatPercent(stakedShare)} of supply staked</span>
      </div>

      {!user ? (
        <Button variant="secondary" className="full-width" onClick={openAuth}>
          Connect to stake
        </Button>
      ) : stake ? (
        <div className="stake-active">
          <div className="stake-active-row">
            <span>Staked</span>
            <strong className="mono">{formatTokens(stake.amountMicro)} ${token.ticker}</strong>
          </div>
          <div className="stake-active-row">
            <span>Locked</span>
            <strong className="mono">{stake.lockDays}d · {stake.multiplierBps / 10_000}× XP</strong>
          </div>
          <div className="stake-active-row">
            <span>{locked ? "Unlocks" : "Unlocked"}</span>
            <strong className="mono">
              {unlockDate ? unlockDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
            </strong>
          </div>
          <div className="stake-actions">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => claimMutation.mutate()}
              loading={claimMutation.isPending}
              disabled={pending <= 0}
            >
              Claim {formatUsd(pending)}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => unstakeMutation.mutate()}
              loading={unstakeMutation.isPending}
              disabled={locked}
              icon={<ArrowUpFromLine size={13} />}
            >
              {locked ? "Locked" : "Unstake"}
            </Button>
          </div>
          <div className="stake-add">
            <span>Add to this lock</span>
            <div className="stake-add-row">
              <input
                value={amount}
                onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ""))}
                placeholder="0"
                inputMode="decimal"
                aria-label="Additional token amount to stake"
              />
              <button onClick={() => setAmount(String(freeTokens / 1_000_000))}>MAX</button>
              <Button
                size="xs"
                variant="primary"
                onClick={() => stakeMutation.mutate()}
                disabled={amountMicro <= 0 || amountMicro > freeTokens}
                loading={stakeMutation.isPending}
              >
                Add
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="stake-form">
          <div className="lock-options">
            {LOCKS.map((lock) => (
              <button
                key={lock.days}
                className={clsx("lock-option", lockDays === lock.days && "lock-option-active")}
                onClick={() => setLockDays(lock.days as 7 | 30 | 90)}
              >
                <strong>{lock.days}d</strong>
                <span>{lock.multiplier} XP</span>
                <em>{lock.note}</em>
              </button>
            ))}
          </div>
          <label className="stake-input">
            <span>Amount</span>
            <div>
              <input
                value={amount}
                onChange={(event) => {
                  const next = event.target.value;
                  if (/^\d*\.?\d*$/.test(next)) setAmount(next);
                }}
                placeholder="0"
                inputMode="decimal"
                aria-label={`Amount of ${token.ticker} to stake`}
              />
              <span className="mono">{token.ticker}</span>
              <button
                onClick={() => setAmount(String(freeTokens / 1_000_000))}
                disabled={freeTokens <= 0}
              >
                MAX
              </button>
            </div>
          </label>
          <Button
            className="full-width"
            size="md"
            onClick={() => stakeMutation.mutate()}
            loading={stakeMutation.isPending}
            disabled={amountMicro <= 0 || amountMicro > freeTokens}
            icon={<LockKeyhole size={14} />}
          >
            Stake {amount || "0"} {token.ticker}
          </Button>
          <span className="staking-free mono">
            {formatTokens(freeTokens, { compact: true })} unlocked · {formatTokens(holding?.stakedMicro ?? 0, { compact: true })} staked
          </span>
        </div>
      )}

      <div className="staking-note">
        <Info size={12} />
        <span>
          Yield accrues per block from real trading fees. No emissions, no token inflation.
        </span>
      </div>
      <button
        className="staking-claim-all"
        onClick={() => claimMutation.mutate()}
        disabled={!user || pending <= 0}
      >
        <ArrowDownToLine size={12} />
        Claim all protocol earnings
        <span className="mono">{formatUsd(pending)}</span>
      </button>
    </Card>
  );
}
