import { useState } from "react";
import clsx from "clsx";
import { useId } from "react";

export function AssetLogo({
  src,
  ticker,
  size = 36,
  className,
  rounded = true,
}: {
  src?: string | null;
  ticker: string;
  size?: number;
  className?: string;
  rounded?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = src && !failed;
  return (
    <span
      className={clsx("asset-logo", className, !rounded && "asset-logo-square")}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.29)) }}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span>{ticker.slice(0, 2).toUpperCase()}</span>
      )}
    </span>
  );
}

export function Sparkline({
  data,
  width = 112,
  height = 34,
  fill = true,
  strokeWidth = 1.6,
  positive,
  className,
}: {
  data: number[];
  width?: number;
  height?: number;
  fill?: boolean;
  strokeWidth?: number;
  positive?: boolean;
  className?: string;
}) {
  const gradientId = `sg-${useId().replace(/:/g, "")}`;
  if (!data.length) {
    return <span className={clsx("sparkline", className)} style={{ width, height }} />;
  }
  const points = data.length === 1 ? [data[0]!, data[0]!] : data;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || Math.max(1, max * 0.001);
  const top = 5;
  const bottom = height - 5;
  const xFor = (index: number) => (index / Math.max(1, points.length - 1)) * width;
  const yFor = (value: number) => bottom - ((value - min) / span) * (bottom - top);
  const line = points.map((point, index) => `${xFor(index).toFixed(2)},${yFor(point).toFixed(2)}`).join(" ");
  const isUp = positive ?? points[points.length - 1]! >= points[0]!;
  const color = isUp ? "var(--positive)" : "var(--negative)";
  const area = `M0,${height} L${line.replaceAll(" ", " L")} L${width},${height} Z`;
  return (
    <svg
      className={clsx("sparkline", className)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {fill ? (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.24" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
      ) : null}
      {fill ? <path d={area} fill={`url(#${gradientId})`} /> : null}
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={xFor(points.length - 1)} cy={yFor(points[points.length - 1]!)} r="2.2" fill={color} />
    </svg>
  );
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const hue = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  return (
    <span
      className="user-avatar"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(140deg, hsl(${hue} 56% 32%), hsl(${(hue + 48) % 360} 44% 20%))`,
        fontSize: Math.max(9, size * 0.34),
      }}
    >
      {name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase()}
    </span>
  );
}
