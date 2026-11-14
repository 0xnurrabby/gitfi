import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  BadgeCheck,
  CircleAlert,
  Clock3,
  Crown,
  Info,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import clsx from "clsx";
import type { QuoteResponse, TokenDetail, UserProfile } from "../../shared/types.js";
import { api, ApiRequestError, idempotencyKey } from "../lib/api.js";
import {
  formatPercent,
  formatPrice,
  formatTokens,
  formatUsd,
} from "../../shared/format.js";
import { useAuth } from "../contexts/AuthContext.js";
import { useToast } from "../contexts/ToastContext.js";
import { useTheme } from "../contexts/ThemeContext.js";
import { Button, Countdown, ProgressBar } from "./ui.js";
import { useRealtimeEvent } from "../contexts/RealtimeContext.js";

const BUY_CHIPS = [50, 250, 500, 1000];
const SELL_CHIPS = [25, 50, 75, 100];

export function TradePanel({
  token,
  initialLivePrice,
}: {
  token: TokenDetail;
  initialLivePrice?: number;
}) {
  const { user, openAuth, setUser } = useAuth();
  const { notify } = useToast();
  const { theme } = useTheme();
  const queryClient = useQueryClient();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [debounced, setDebounced] = useState("");
  const [livePrice, setLivePrice] = useState(initialLivePrice ?? token.priceMicro);
  const [justTraded, setJustTraded] = useState(false);

  useEffect(() => {
    setLivePrice(token.priceMicro);
  }, [token.priceMicro]);

  useRealtimeEvent((event) => {
    if (event.type === "trade" && event.tokenId === token.id) {
      const payload = event.data as { priceMicro?: number };
      if (payload.priceMicro) setLivePrice(payload.priceMicro);
    }
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(amount), 260);
    return () => window.clearTimeout(timer);
  }, [amount]);

  const holding = token.myHolding;
  const availableTokens = holding
    ? Math.max(0, holding.amountMicro - holding.stakedMicro - holding.vestedMicro)
    : 0;
  const availableUsd = user?.usdMicro ?? 0;
  const isPrelaunch = token.curve.prelaunchSeconds > 0;
  const disabled = !token.curve.canTrade || isPrelaunch;

  useEffect(() => {
    if (token.curve.prelaunchSeconds <= 0) return;
    const timer = window.setTimeout(
      () => queryClient.invalidateQueries({ queryKey: ["token"] }),
      token.curve.prelaunchSeconds * 1000 + 900,
    );
    return () => window.clearTimeout(timer);
  }, [queryClient, token.curve.prelaunchSeconds, token.id]);

  const numericAmount = Number.parseFloat(debounced.replaceAll(",", "")) || 0;
  const amountMicro =
    side === "buy"
      ? Math.floor(numericAmount * 1_000_000)
      : Math.floor(numericAmount * 1_000_000);
  const quoteEnabled =
    amountMicro > 0 && token.curve.canTrade && !isPrelaunch && (side === "buy" || Boolean(user));

  const quoteQuery = useQuery({
    queryKey: ["quote", token.id, side, amountMicro, user?.id],
    queryFn: () =>
      api<QuoteResponse>(`/api/tokens/${token.id}/quote`, {
        method: "POST",
        body: {
          side,
          input: side === "buy" ? "usd" : "token",
          amountMicro,
        },
      }),
    enabled: quoteEnabled,
    staleTime: 0,
    refetchInterval: quoteEnabled ? 10_000 : false,
    retry: false,
  });

  const quote = quoteQuery.data;
  const quoteError =
    quoteQuery.error instanceof ApiRequestError ? quoteQuery.error.message : null;
  const displayPrice = quote?.priceAfterMicro || livePrice;
  const displayPriceBefore = quote?.priceBeforeMicro || livePrice;
  const totalFeeRate = token.status === "bonding" && token.isKing ? 50 : 100;
  const feeLabel = token.isKing ? "0.5% (platform waived)" : "1.0%";

  const tradeMutation = useMutation({
    mutationFn: async () => {
      if (!user) throw new ApiRequestError("Connect a wallet first.", 401, "AUTH_REQUIRED");
      return api<{
        trade: { tokensMicro: number; usdMicro: number; feeMicro: number };
        tokenDetail: TokenDetail;
        user: UserProfile;
      }>(`/api/tokens/${token.id}/trade`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: {
          side,
          input: side === "buy" ? "usd" : "token",
          amountMicro,
          minOutMicro: quote
            ? Math.floor(
                (side === "buy" ? quote.tokensMicro : quote.totalMicro) * 0.995,
              )
            : undefined,
        },
      });
    },
    onSuccess: (result) => {
      setUser(result.user);
      setAmount("");
      setJustTraded(true);
      window.setTimeout(() => setJustTraded(false), 1100);
      queryClient.invalidateQueries({ queryKey: ["token"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["tokenTabs", token.id] });
      queryClient.invalidateQueries({ queryKey: ["home"] });
      queryClient.invalidateQueries({ queryKey: ["chart", token.id] });
      queryClient.invalidateQueries({ queryKey: ["quote", token.id] });
      notify(
        `${side === "buy" ? "Bought" : "Sold"} ${formatTokens(result.trade.tokensMicro, { compact: true })} $${token.ticker} for ${formatUsd(result.trade.usdMicro)}.`,
        {
          kind: "success",
          title: side === "buy" ? "Position opened" : "Position closed",
        },
      );
    },
    onError: (error) => {
      notify(error instanceof ApiRequestError ? error.message : "Trade failed.", {
        kind: "error",
        title: "No funds moved",
      });
    },
  });

  const setPercent = (percent: number) => {
    if (side === "buy") {
      const value = (availableUsd * percent) / 100;
      setAmount(value > 0 ? (value / 1_000_000).toFixed(2) : "");
    } else {
      const value = (availableTokens * percent) / 100;
      setAmount(value > 0 ? (value / 1_000_000).toFixed(Math.min(6, Math.max(2, Math.ceil(value / 1_000_000).toString().length - 1))) : "");
    }
  };

  const canTrade =
    quote != null &&
    quote.tokensMicro > 0 &&
    quote.errors.length === 0 &&
    !tradeMutation.isPending &&
    !disabled;

  return (
    <aside className={clsx("trade-panel", justTraded && "trade-panel-flash")}>
      <div className="trade-panel-head">
        <div>
          <span className="trade-kicker mono">{token.curve.canTrade ? "EXECUTE" : "MARKET STATUS"}</span>
          <h2>Trade ${token.ticker}</h2>
        </div>
        <div className="trade-price-head">
          <span className="mono">{formatPrice(displayPrice)}</span>
          <span className={displayPrice >= displayPriceBefore ? "text-positive" : "text-negative"}>
            {livePrice > 0 ? `${formatPercent(token.change24hBps, { sign: true })}` : "—"}
          </span>
        </div>
      </div>

      {token.isKing ? (
        <div className="king-boost">
          <Crown size={12} />
          <span>King boost active — platform fee waived</span>
          <span className="mono">−0.5%</span>
        </div>
      ) : null}

      {isPrelaunch ? (
        <div className="prelaunch-panel">
          <Clock3 size={17} />
          <div>
            <strong>Curve opens soon</strong>
            <span>Viral-tier pre-launch prevents sniper deployment.</span>
          </div>
          <Countdown to={token.launchAt ?? new Date().toISOString()} />
        </div>
      ) : null}

      {token.royaltyFrozen || token.verification === "hidden" ? (
        <div className="frozen-banner">
          <CircleAlert size={14} />
          <span>Repository is private or unavailable. Developer royalties are frozen. Trading remains live for holders to exit; discovery is disabled.</span>
        </div>
      ) : null}

      <div className="trade-toggle">
        <button
          className={clsx("trade-toggle-btn", "buy", side === "buy" && "active")}
          onClick={() => {
            setSide("buy");
            setAmount("");
          }}
        >
          <ArrowUp size={14} /> Buy
        </button>
        <button
          className={clsx("trade-toggle-btn", "sell", side === "sell" && "active")}
          onClick={() => {
            setSide("sell");
            setAmount("");
          }}
        >
          <ArrowDown size={14} /> Sell
        </button>
      </div>

      <div className="trade-balance-row">
        <span className="mono">
          {side === "buy" ? (
            <>AVAILABLE <strong>{user ? formatUsd(availableUsd) : "—"}</strong></>
          ) : (
            <>UNLOCKED <strong>{user ? `${formatTokens(availableTokens, { compact: true })} ${token.ticker}` : "—"}</strong></>
          )}
        </span>
        <button className="text-button" onClick={() => setPercent(100)} disabled={!user}>
          Max
        </button>
      </div>

      <label className={clsx("trade-input", side === "sell" && "trade-input-sell")}>
        <span>{side === "buy" ? "You pay" : "You sell"}</span>
        <div className="trade-input-row">
          <input
            value={amount}
            onChange={(event) => {
              const value = event.target.value;
              if (/^\d*\.?\d*$/.test(value)) setAmount(value);
            }}
            placeholder="0.00"
            inputMode="decimal"
            aria-label={side === "buy" ? "Amount in USDC" : `Amount in ${token.ticker}`}
          />
          <span className="trade-input-suffix">{side === "buy" ? "USDC" : token.ticker}</span>
        </div>
        <span className="trade-input-usd mono">
          {side === "buy"
            ? `${amount || "0"} USDC`
            : quote
              ? `≈ ${formatUsd(quote.totalMicro)}`
              : "—"}
        </span>
      </label>

      <div className="trade-chips">
        {(side === "buy" ? BUY_CHIPS : SELL_CHIPS).map((chip) => (
          <button
            key={chip}
            onClick={() =>
              side === "buy"
                ? setAmount(String(chip))
                : setPercent(chip)
            }
            disabled={!user}
          >
            {side === "buy" ? `$${chip}` : `${chip}%`}
          </button>
        ))}
      </div>

      {amountMicro > 0 ? (
        <div className="trade-quote">
          <div className="trade-quote-row">
            <span>{side === "buy" ? "You receive" : "Net proceeds"}</span>
            <strong className="mono">
              {quote && quote.tokensMicro > 0
                ? side === "buy"
                  ? `${formatTokens(quote.tokensMicro, { compact: true })} ${token.ticker}`
                  : formatUsd(quote.totalMicro)
                : "—"}
            </strong>
          </div>
          <div className="trade-quote-row">
            <span>Average price</span>
            <span className="mono">
              {quote && quote.tokensMicro > 0 && quote.baseCostMicro > 0
                ? formatPrice((quote.baseCostMicro * 1_000_000) / quote.tokensMicro)
                : formatPrice(displayPrice)}
            </span>
          </div>
          <div className="trade-quote-row">
            <span>Trade fee <span className="fee-info">{feeLabel}</span></span>
            <span className="mono">{quote ? formatUsd(quote.feeMicro) : "—"}</span>
          </div>
          <div className="trade-quote-row trade-quote-sub">
            <span>↳ Developer royalty</span>
            <span className="mono">{quote ? formatUsd(quote.feeSplit.developerMicro) : "—"}</span>
          </div>
          <div className="trade-quote-row trade-quote-sub">
            <span>↳ Holder dividends</span>
            <span className="mono">{quote ? formatUsd(quote.feeSplit.dividendMicro) : "—"}</span>
          </div>
          <div className="trade-quote-row trade-quote-sub">
            <span>↳ Treasury</span>
            <span className="mono">{quote ? formatUsd(quote.feeSplit.platformNetMicro) : "—"}</span>
          </div>
          <div className="trade-quote-row">
            <span>Price impact</span>
            <span className={clsx("mono", quote && quote.priceImpactBps >= 0 ? "text-positive" : "text-negative")}>
              {quote ? `${quote.priceImpactBps >= 0 ? "+" : ""}${formatPercent(quote.priceImpactBps, { decimals: 2 })}` : "—"}
            </span>
          </div>
          <div className="trade-quote-divider" />
          <div className="trade-quote-row trade-total">
            <span>{side === "buy" ? "Total cost" : "You receive"}</span>
            <strong className="mono">
              {quote ? formatUsd(quote.totalMicro) : "—"}
            </strong>
          </div>
        </div>
      ) : null}

      {quote?.errors.length ? (
        <div className="quote-warning">
          <CircleAlert size={13} /> {quote.errors[0]}
        </div>
      ) : null}
      {quoteError ? (
        <div className="quote-warning">
          <CircleAlert size={13} /> {quoteError}
        </div>
      ) : null}

      {side === "buy" && quote?.walletCapTokensMicro && token.status === "bonding" ? (
        <div className="wallet-cap">
          <ShieldCheck size={12} />
          <span>
            Curve cap {formatPercent((quote.walletCapTokensMicro / token.circulation.totalSupplyMicro) * 10_000, { decimals: 1 })}
            {" "}per wallet
          </span>
        </div>
      ) : null}

      <Button
        size="lg"
        variant={side === "buy" ? "primary" : "danger"}
        className={clsx("trade-submit", side === "sell" && "trade-submit-sell")}
        disabled={disabled || (!user ? false : !canTrade)}
        loading={tradeMutation.isPending}
        onClick={() => {
          if (!user) {
            openAuth();
            return;
          }
          if (canTrade) tradeMutation.mutate();
        }}
      >
        {!user
          ? "Connect wallet to trade"
          : disabled
            ? token.royaltyFrozen
              ? "Market paused"
              : "Curve opens soon"
            : quoteQuery.isFetching
              ? "Updating quote…"
              : quote?.errors.length || !amount
                ? "Enter an amount"
                : side === "buy"
                  ? `Buy ${token.ticker}`
                  : `Sell ${token.ticker}`}
      </Button>

      <div className="trade-foot mono">
        <span>1% fee</span>
        <span>·</span>
        <span>{token.curve.canTrade ? "instant settlement" : "curve status"}</span>
        <span>·</span>
        <span>0.5% slippage guard</span>
      </div>

      {holding && holding.vestedMicro > 0 ? (
        <div className="vesting-note">
          <LockKeyhole size={12} />
          <span>
            {formatTokens(holding.vestedMicro, { compact: true })} ${token.ticker} is vesting
            {holding.vestedUntil ? ` until ${new Date(holding.vestedUntil).toLocaleDateString()}` : ""}.
          </span>
        </div>
      ) : null}

      {token.status !== "graduated" ? (
        <div className="trade-curve-foot">
          <div>
            <span>Curve progress</span>
            <span className="mono">{formatPercent(token.progressBps, { decimals: 1 })}</span>
          </div>
          <ProgressBar value={token.progressBps / 100} tone={token.tier === "viral" ? "red" : token.tier === "rising" ? "amber" : "lime"} />
          <div className="trade-curve-meta mono">
            <span>{formatUsd(token.marketCapMicro, { compact: true })} mcap</span>
            <span>→ {formatUsd(token.graduationTargetMicro, { compact: true })}</span>
          </div>
        </div>
      ) : (
        <div className="dex-foot">
          <BadgeCheck size={13} /> Graduated to open DEX liquidity
        </div>
      )}
    </aside>
  );
}
