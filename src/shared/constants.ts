export const APP_NAME = "GitFi.fun";
export const APP_TAGLINE = "Public code. Priced in public.";
export const APP_DESCRIPTION =
  "GitFi turns public GitHub repositories into verified, tradeable utility tokens with developer royalties, live star momentum and holder yield.";

export const GITHUB_RAW_HOST = "raw.githubusercontent.com";
export const VIP_THRESHOLD_BPS = 5; // 0.05% of supply
export const DEFAULT_PAGE_SIZE = 24;

export const STAR_HEALTH = {
  healthy: 75,
  watch: 50,
  degraded: 25,
} as const;

export const FEE_COPY = {
  developer: "0.50%",
  platform: "0.50%",
  yield: "0.20%",
  total: "1.00%",
} as const;

export const REPO_REGEX = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const TICKER_REGEX = /^[A-Z0-9]{2,10}$/;
export const CHAT_MAX = 500;
export const BIO_MAX = 280;
