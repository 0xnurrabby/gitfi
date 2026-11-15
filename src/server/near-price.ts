
interface Quote {
  usd: number;
  source: string;
  updatedAt: number;
}

const SOURCES: Array<{ name: string; url: string; parse: (body: unknown) => number }> = [
  {
    name: "binance",
    url: "https://api.binance.com/api/v3/ticker/price?symbol=NEARUSDT",
    parse: (body) => Number((body as { price?: string }).price),
  },
  {
    name: "coinbase",
    url: "https://api.coinbase.com/v2/prices/NEAR-USD/spot",
    parse: (body) => Number((body as { data?: { amount?: string } }).data?.amount),
  },
  {
    name: "coingecko",
    url: "https://api.coingecko.com/api/v3/simple/price?ids=near&vs_currencies=usd",
    parse: (body) => Number((body as { near?: { usd?: number } }).near?.usd),
  },
];

let cached: Quote | null = null;
let inflight: Promise<Quote> | null = null;

async function fetchQuote(): Promise<Quote> {
  for (const source of SOURCES) {
    try {
      const response = await fetch(source.url, {
        signal: AbortSignal.timeout(4500),
        headers: { accept: "application/json" },
      });
      if (!response.ok) continue;
      const usd = source.parse(await response.json());
      if (Number.isFinite(usd) && usd > 0) {
        return { usd, source: source.name, updatedAt: Date.now() };
      }
    } catch {
    }
  }
  if (cached) return cached;
  return { usd: 0, source: "unavailable", updatedAt: Date.now() };
}

export async function getNearUsd(): Promise<Quote> {
  if (cached && Date.now() - cached.updatedAt < 30_000) return cached;
  if (!inflight) {
    inflight = fetchQuote()
      .then((quote) => {
        if (quote.usd > 0) cached = quote;
        return quote;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function yoctoToUsdMicro(yocto: bigint, nearUsd: number): number {
  if (nearUsd <= 0) return 0;
  return Number((yocto * BigInt(Math.round(nearUsd * 1_000_000))) / 10n ** 24n);
}
