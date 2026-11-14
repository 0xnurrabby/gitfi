import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";
import type { ChartCandle, ChartResponse, TokenDetail } from "../../shared/types.js";
import { api } from "../lib/api.js";
import { smoothPath } from "../lib/chart.js";
import { formatPrice, formatUsd } from "../../shared/format.js";
import { useRealtimeEvent } from "../contexts/RealtimeContext.js";
import { Skeleton } from "./ui.js";
import clsx from "clsx";

type Range = "1H" | "24H" | "7D" | "30D" | "ALL";
const RANGES: Range[] = ["1H", "24H", "7D", "30D", "ALL"];

function intervalSeconds(interval: string): number {
  const match = interval.match(/^(\d+)([mhd])$/);
  if (!match) return 300;
  const value = Number(match[1]);
  const unit = match[2];
  return value * (unit === "m" ? 60 : unit === "h" ? 3600 : 86400);
}

function formatAxisTime(seconds: number, range: Range): string {
  const date = new Date(seconds * 1000);
  if (range === "1H" || range === "24H") {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  if (range === "7D") {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatTooltipTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PriceChart({ token }: { token: TokenDetail }) {
  const [range, setRange] = useState<Range>("24H");
  const [candles, setCandles] = useState<ChartCandle[]>([]);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const lastLiveRef = useRef<number>(0);

  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: ["chart", token.id, range],
    queryFn: () => api<ChartResponse>(`/api/tokens/${token.id}/chart?range=${range}`),
    staleTime: 20_000,
  });

  useEffect(() => {
    if (data) {
      setCandles(data.candles);
      setHover(null);
    }
  }, [data]);

  useRealtimeEvent((event) => {
    if (event.type !== "trade" || event.tokenId !== token.id) return;
    const payload = event.data as {
      priceMicro?: number;
      usdMicro?: number;
      side?: "buy" | "sell";
      time?: number;
    };
    if (!payload?.priceMicro) return;
    const now = Math.floor((payload.time ?? Date.now()) / 1000);
    if (now - lastLiveRef.current < 120 && lastLiveRef.current !== 0) return;
    lastLiveRef.current = now;
    const bucket = intervalSeconds(data?.interval ?? "5m");
    const bucketTime = Math.floor(now / bucket) * bucket;
    setCandles((current) => {
      const price = payload.priceMicro!;
      const volume = payload.usdMicro ?? 0;
      if (!current.length) {
        return [{ time: bucketTime, open: price, high: price, low: price, close: price, volumeMicro: volume }];
      }
      const last = current[current.length - 1]!;
      if (bucketTime === last.time) {
        return [
          ...current.slice(0, -1),
          {
            ...last,
            high: Math.max(last.high, price),
            low: Math.min(last.low, price),
            close: price,
            volumeMicro: last.volumeMicro + volume,
          },
        ];
      }
      if (bucketTime > last.time) {
        return [
          ...current.slice(-420),
          {
            time: bucketTime,
            open: last.close,
            high: Math.max(last.close, price),
            low: Math.min(last.close, price),
            close: price,
            volumeMicro: volume,
          },
        ];
      }
      return current;
    });
  });

  const width = 1000;
  const height = 320;
  const margin = { top: 16, right: 66, bottom: 26, left: 8 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const priceH = plotH;

  const summary = useMemo(() => {
    if (!candles.length) return null;
    const closes = candles.map((candle) => candle.close);
    const window = Math.max(1, Math.min(5, Math.floor(closes.length / 8)));
    const smoothed = closes.map((_, index) => {
      let total = 0;
      let count = 0;
      for (let offset = -window; offset <= window; offset += 1) {
        const value = closes[index + offset];
        if (value === undefined) continue;
        total += value;
        count += 1;
      }
      return total / count;
    });
    const min = Math.min(...smoothed);
    const max = Math.max(...smoothed);
    const pad = (max - min) * 0.2 || Math.max(1, max * 0.012);
    const last = candles[candles.length - 1]!;
    const first = candles[0]!;
    return {
      min: Math.max(0, min - pad),
      max: max + pad,
      smoothed,
      last,
      first,
      change: first.close ? ((last.close - first.close) / first.close) * 100 : 0,
    };
  }, [candles]);

  if (isError) {
    return (
      <div className="chart-empty">
        <p>Price history unavailable.</p>
        <button className="btn btn-secondary btn-sm" onClick={() => refetch()}>
          Retry chart
        </button>
      </div>
    );
  }
  if (isLoading || !summary) {
    return (
      <div className="price-chart-wrap">
        <div className="chart-controls">
          <Skeleton style={{ width: 160, height: 24 }} />
          <div className="chart-range-group">
            {RANGES.map((item) => (
              <Skeleton key={item} style={{ width: 34, height: 26 }} />
            ))}
          </div>
        </div>
        <Skeleton className="chart-skeleton" />
      </div>
    );
  }

  const yFor = (value: number) =>
    margin.top + priceH - ((value - summary.min) / (summary.max - summary.min)) * priceH;
  const slot = plotW / Math.max(1, candles.length);
  const points = candles.map((_, index) => ({
    x: margin.left + (index + 0.5) * slot,
    y: yFor(summary.smoothed[index]!),
  }));
  const line = smoothPath(points);
  const area = `${line} L ${points[points.length - 1]!.x.toFixed(2)} ${margin.top + priceH} L ${points[0]!.x.toFixed(2)} ${margin.top + priceH} Z`;
  const lastPoint = points[points.length - 1]!;
  const up = summary.change >= 0;
  const chartTone = up ? "var(--positive)" : "var(--negative)";
  const priceTicks = Array.from({ length: 4 }, (_, index) => {
    const value = summary.min + ((summary.max - summary.min) * index) / 3;
    return { value, y: yFor(value) };
  });
  const timeTickCount = 5;
  const timeTicks = Array.from({ length: timeTickCount }, (_, index) => {
    const candleIndex = Math.min(
      candles.length - 1,
      Math.floor((index * (candles.length - 1)) / Math.max(1, timeTickCount - 1)),
    );
    const candle = candles[candleIndex];
    return candle
      ? { x: margin.left + (candleIndex + 0.5) * slot, label: formatAxisTime(candle.time, range) }
      : null;
  }).filter((value): value is { x: number; label: string } => Boolean(value));
  const hovered = hover ? candles[hover.index] : null;
  const hoverPoint = hover ? points[hover.index] : null;

  return (
    <div className="price-chart-wrap" ref={wrapperRef}>
      <div className="chart-controls">
        <div className="chart-legend">
          <span className="chart-legend-title">
            <BarChart3 size={14} /> Price
          </span>
          <span className={clsx("chart-change", up ? "text-positive" : "text-negative")}>
            {up ? "+" : ""}
            {summary.change.toFixed(2)}%
          </span>
          <span className="chart-live">
            <span className={clsx("signal-dot", isFetching && "pulse")} /> live
          </span>
        </div>
        <div className="chart-range-group" role="group" aria-label="Chart range">
          {RANGES.map((item) => (
            <button
              key={item}
              className={clsx("chart-range", range === item && "chart-range-active")}
              onClick={() => setRange(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-canvas-wrap">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="price-chart"
          role="img"
          aria-label={`${token.name} price chart`}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const relative = ((event.clientX - rect.left) / rect.width) * width;
            if (relative < margin.left || relative > margin.left + plotW) {
              setHover(null);
              return;
            }
            const index = Math.max(
              0,
              Math.min(candles.length - 1, Math.floor((relative - margin.left) / slot)),
            );
            setHover({
              index,
              x: (event.clientX - rect.left) / rect.width,
              y: (event.clientY - rect.top) / rect.height,
            });
          }}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={`chart-area-${token.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={chartTone} stopOpacity="0.2" />
              <stop offset="70%" stopColor={chartTone} stopOpacity="0.03" />
              <stop offset="100%" stopColor={chartTone} stopOpacity="0" />
            </linearGradient>
          </defs>

          {priceTicks.map((tick) => (
            <g key={tick.y}>
              <line
                x1={margin.left}
                x2={margin.left + plotW}
                y1={tick.y}
                y2={tick.y}
                className="chart-grid-line"
              />
              <text x={width - 6} y={tick.y + 3.5} className="chart-axis-text" textAnchor="end">
                {formatPrice(tick.value)}
              </text>
            </g>
          ))}

          {timeTicks.map((tick) => (
            <text
              key={tick.x}
              x={tick.x}
              y={height - 8}
              className="chart-axis-text"
              textAnchor="middle"
            >
              {tick.label}
            </text>
          ))}

          <path d={area} fill={`url(#chart-area-${token.id})`} />
          <path d={line} fill="none" stroke={chartTone} strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />

          <line
            x1={margin.left}
            x2={margin.left + plotW}
            y1={lastPoint.y}
            y2={lastPoint.y}
            className="chart-last-line"
          />
          <circle cx={lastPoint.x} cy={lastPoint.y} r="3" fill={chartTone} />
          <rect
            x={width - margin.right + 2}
            y={lastPoint.y - 10}
            width={margin.right - 6}
            height={20}
            rx="4"
            fill={chartTone}
          />
          <text x={width - margin.right + 9} y={lastPoint.y + 3.5} className="chart-last-label">
            {formatPrice(summary.last.close)}
          </text>

          {hover && hovered && hoverPoint ? (
            <>
              <line
                x1={hoverPoint.x}
                x2={hoverPoint.x}
                y1={margin.top}
                y2={height - margin.bottom}
                className="chart-crosshair"
              />
              <circle cx={hoverPoint.x} cy={hoverPoint.y} r="4" fill="var(--surface)" stroke={chartTone} strokeWidth="2" />
            </>
          ) : null}
        </svg>

        {hover && hovered ? (
          <div
            className="chart-tooltip"
            style={{
              left: `${Math.min(76, Math.max(2, hover.x * 100 + 2))}%`,
              top: `${Math.min(68, Math.max(4, hover.y * 100 - 6))}%`,
            }}
          >
            <span className="chart-tooltip-time mono">{formatTooltipTime(hovered.time)}</span>
            <div className="chart-tooltip-price mono">{formatPrice(hovered.close)}</div>
            <div className="chart-tooltip-meta mono">
              <span>VOL</span>
              <strong>{formatUsd(hovered.volumeMicro, { compact: true })}</strong>
            </div>
          </div>
        ) : null}
      </div>
      <div className="chart-footer mono">
        <span>PRICE · USD</span>
        <span>LIVE FROM THE CURVE</span>
        <span className="chart-footer-events">{candles.length} BUCKETS</span>
      </div>
    </div>
  );
}
