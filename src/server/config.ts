import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

try {
  process.loadEnvFile(path.join(root, ".env"));
} catch {
  // .env is optional.
}

const isProduction = process.env.NODE_ENV === "production";
const dataDir = path.resolve(process.env.GITFI_DATA_DIR ?? path.join(root, "data"));
fs.mkdirSync(dataDir, { recursive: true });

function persistentSecret(name: string, envName: string): string {
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.length >= 24) return fromEnv;
  const file = path.join(dataDir, `.${name}`);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 24) return existing;
  } catch {
    // generate below
  }
  const generated = crypto.randomBytes(48).toString("base64url");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

export const config = {
  root,
  isProduction,
  port: Number(process.env.PORT ?? 8787),
  appUrl: process.env.APP_URL ?? (isProduction ? "http://localhost:8787" : "http://localhost:5173"),
  sessionSecret: persistentSecret("session-secret", "SESSION_SECRET"),
  adminToken: persistentSecret("admin-token", "ADMIN_TOKEN"),
  githubToken: process.env.GITHUB_TOKEN ?? "",
  openaiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  nearNetwork: process.env.NEAR_NETWORK ?? "testnet",
  nearContractId: process.env.NEAR_CONTRACT_ID ?? "gitfi-395012.testnet",
  nearMarketContractId:
    process.env.NEAR_MARKET_CONTRACT_ID ?? "market.gitfi-395012.testnet",
  nearRpcUrl:
    process.env.NEAR_RPC_URL ??
    ((process.env.NEAR_NETWORK ?? "testnet") === "mainnet"
      ? "https://rpc.mainnet.fastnear.com"
      : (process.env.NEAR_NETWORK ?? "testnet") === "testnet"
        ? "https://rpc.testnet.fastnear.com"
        : "http://localhost:3030"),
  nearExplorerUrl:
    process.env.NEAR_EXPLORER_URL ??
    ((process.env.NEAR_NETWORK ?? "testnet") === "mainnet"
      ? "https://explorer.near.org"
      : "https://explorer.testnet.near.org"),
  nearOracleAccountId: process.env.NEAR_ORACLE_ACCOUNT_ID ?? "gitfi-395012.testnet",
  teamAddress:
    process.env.TEAM_ADDRESS ??
    process.env.NEAR_ORACLE_ACCOUNT_ID ??
    "gitfi-395012.testnet",
  launchFeeYocto: process.env.LAUNCH_FEE_YOCTO ?? "1000000000000000000000000",
  tradeFeeBps: 130,
  creatorFeeBps: 50,
  teamFeeBps: 30,
  stakerFeeBps: 50,
  nearChainEnabled: process.env.NEAR_CHAIN_ENABLED !== "false",
  nearCredentialsDir:
    process.env.NEAR_CREDENTIALS_DIR ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".near-credentials"),
  nearOraclePrivateKey: process.env.NEAR_ORACLE_PRIVATE_KEY ?? "",
  nearAuthRecipient: process.env.NEAR_AUTH_RECIPIENT ?? (() => {
    try {
      return new URL(process.env.APP_URL ?? "http://localhost:8787").host;
    } catch {
      return "gitfi.fun";
    }
  })(),
  pinataJwt: process.env.PINATA_JWT ?? "",
  pinataGateway: process.env.PINATA_GATEWAY ?? "https://gateway.pinata.cloud/ipfs",
  seedDemo: process.env.SEED_DEMO !== "false",
  demoMode: process.env.DEMO_MODE !== "false",
  platformYieldShareBps: Number(process.env.PLATFORM_YIELD_SHARE_BPS ?? 4000),
  cookieName: "gitfi_session",
} as const;

export function warn(msg: string): void {
  console.warn(`[gitfi] ${msg}`);
}

export function log(msg: string): void {
  console.log(`[gitfi] ${msg}`);
}
