import fs from "node:fs";
import crypto from "node:crypto";
import bs58 from "bs58";

const RPC = process.env.MAINNET_RPC_URL ?? "https://rpc.mainnet.fastnear.com";
const required = [
  "MAINNET_DEPLOYER_ACCOUNT",
  "MAINNET_OWNER_ACCOUNT",
  "MAINNET_ORACLE_ACCOUNT",
  "MAINNET_REGISTRY_ACCOUNT",
  "MAINNET_MARKET_ACCOUNT",
  "PLATFORM_FEE_ADDRESS",
  "ORACLE_SEED_HEX",
];

const missing = required.filter((key) => !process.env[key]?.trim());
const files = [
  "contracts/target/wasm32-unknown-unknown/release/gitfi_market.wasm",
  "contracts/target/wasm32-unknown-unknown/release/gitfi_repo_registry.wasm",
];

async function account(accountId) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: accountId },
    }),
  });
  const payload = await response.json();
  if (!payload.result) return null;
  return {
    near: Number(payload.result.amount) / 1e24,
    storage: payload.result.storage_usage,
  };
}

console.log("GitFi mainnet preflight");
console.log("RPC:", RPC);
if (missing.length) {
  console.log("Missing env:", missing.join(", "));
} else {
  console.log("Env: complete");
}

let totalBytes = 0;
for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log("Missing WASM:", file, "(run cargo build --target wasm32-unknown-unknown --release)");
    continue;
  }
  const bytes = fs.readFileSync(file);
  totalBytes += bytes.length;
  const hash = crypto.createHash("sha256").update(bytes).digest();
  console.log(file, "bytes:", bytes.length, "code hash:", bs58.encode(hash));
}
console.log("Estimated code storage:", (totalBytes * 1e-5).toFixed(3), "NEAR");

for (const key of [
  "MAINNET_DEPLOYER_ACCOUNT",
  "MAINNET_OWNER_ACCOUNT",
  "MAINNET_ORACLE_ACCOUNT",
  "MAINNET_REGISTRY_ACCOUNT",
  "MAINNET_MARKET_ACCOUNT",
  "PLATFORM_FEE_ADDRESS",
]) {
  const value = process.env[key];
  if (!value) continue;
  try {
    const balance = await account(value);
    console.log(key, value, balance ? `${balance.near.toFixed(4)} NEAR` : "missing / not created");
  } catch (error) {
    console.log(key, value, "lookup failed:", error.message);
  }
}
