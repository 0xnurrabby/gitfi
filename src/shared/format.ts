export function formatUsd(micro: number | bigint, opts?: { compact?: boolean; decimals?: number; sign?: boolean }): string {
  const value = Number(micro) / 1_000_000;
  const sign = opts?.sign && value > 0 ? "+" : "";
  if (value === 0) return "$0.00";
  if (opts?.compact && Math.abs(value) >= 10_000) {
    return `${sign}$${compact(value)}`;
  }
  const decimals = opts?.decimals ?? (Math.abs(value) < 0.01 ? 6 : Math.abs(value) < 1 ? 4 : 2);
  return `${sign}$${value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

export function formatPrice(micro: number | bigint): string {
  const value = Number(micro) / 1_000_000;
  if (value === 0) return "$0.00";
  if (value >= 1) return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  if (value >= 0.0001) return `$${value.toFixed(6)}`;
  if (value >= 0.000001) return `$${value.toFixed(6)}`;
  if (value >= 0.00000001) return `$${value.toFixed(8)}`;
  return `$${value.toFixed(10)}`;
}

function subscript(n: number): string {
  if (n < 4) return "0".repeat(n);
  const chars = "₀₁₂₃₄₅₆₇₈₉";
  return [...String(n)].map((d) => chars[Number(d)]).join("");
}

export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(2);
}

export function formatNumber(value: number, decimals = 0): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  });
}

export function formatCompact(value: number): string {
  return compact(value);
}

/** Micro-token amounts -> human token count. */
export function formatTokens(micro: number | bigint, opts?: { compact?: boolean }): string {
  const value = Number(micro) / 1_000_000;
  if (opts?.compact || Math.abs(value) >= 1_000_000) return compact(value);
  if (Math.abs(value) >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (Math.abs(value) >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function formatPercent(bps: number, opts?: { sign?: boolean; decimals?: number }): string {
  const value = bps / 100;
  const sign = opts?.sign && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(opts?.decimals ?? 1)}%`;
}

export function formatTimeAgo(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  const diff = Math.max(0, Date.now() - date.getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "now";
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function truncateAddress(address: string, start = 6, end = 4): string {
  if (address.length <= start + end + 1) return address;
  return `${address.slice(0, start)}…${address.slice(-end)}`;
}

export function shortNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function timeAgo(input: string | number | Date): string {
  return formatTimeAgo(input);
}
