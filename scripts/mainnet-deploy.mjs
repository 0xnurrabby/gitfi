import fs from "node:fs";
import crypto from "node:crypto";
import nacl from "tweetnacl";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from "near-api-js";

const RPC = process.env.MAINNET_RPC_URL ?? "https://rpc.mainnet.fastnear.com";
const deployerId = process.env.MAINNET_DEPLOYER_ACCOUNT ?? "gitfifun.near";
const ownerId = process.env.MAINNET_OWNER_ACCOUNT ?? "owner.gitfifun.near";
const oracleId = process.env.MAINNET_ORACLE_ACCOUNT ?? "oracle.gitfifun.near";
const registryId = process.env.MAINNET_REGISTRY_ACCOUNT ?? "registry.gitfifun.near";
const marketId = process.env.MAINNET_MARKET_ACCOUNT ?? "market.gitfifun.near";
const feesId = process.env.PLATFORM_FEE_ADDRESS ?? "fees.gitfifun.near";

const registryWasm = "contracts/target/wasm32-unknown-unknown/release/gitfi_repo_registry.wasm";
const marketWasm = "contracts/target/wasm32-unknown-unknown/release/gitfi_market.wasm";
const keyFile = "data/mainnet-deployer-key.json";
const ownerKeyFile = "data/mainnet-owner-key.json";
const oracleKeyFile = "data/mainnet-oracle-key.json";

const NEAR = 10n ** 24n;
const REGISTRY_FUND = 5n * NEAR;
const MARKET_FUND = 12n * NEAR;
const OWNER_FUND = NEAR / 2n;
const ORACLE_FUND = NEAR / 2n;
const FEES_FUND = NEAR / 10n;

function loadOrCreateKey(file) {
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    return KeyPair.fromString(saved.secret_key);
  }
  const key = KeyPair.fromRandom("ed25519");
  fs.writeFileSync(file, JSON.stringify({ secret_key: key.toString(), public_key: key.getPublicKey().toString() }, null, 2));
  return key;
}

if (!fs.existsSync(keyFile)) throw new Error(`missing ${keyFile}`);
const deployerKeyFile = JSON.parse(fs.readFileSync(keyFile, "utf8"));
const deployerKey = KeyPair.fromString(deployerKeyFile.private_key);
const ownerKey = loadOrCreateKey(ownerKeyFile);
const oracleKey = loadOrCreateKey(oracleKeyFile);
const oracleSeedFile = "data/mainnet-oracle-seed.txt";
let oracleSeed = process.env.ORACLE_SEED_HEX?.trim();
if (!oracleSeed) {
  if (fs.existsSync(oracleSeedFile)) {
    oracleSeed = fs.readFileSync(oracleSeedFile, "utf8").trim();
  } else {
    oracleSeed = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(oracleSeedFile, oracleSeed);
  }
}
if (!/^[0-9a-f]{64}$/i.test(oracleSeed)) {
  throw new Error("ORACLE_SEED_HEX must be 32 bytes of hex");
}
const deedPublicKey = Buffer.from(
  nacl.sign.keyPair.fromSeed(Buffer.from(oracleSeed, "hex")).publicKey,
);
const registryCode = new Uint8Array(fs.readFileSync(registryWasm));
const marketCode = new Uint8Array(fs.readFileSync(marketWasm));

const provider = new JsonRpcProvider({ url: RPC });
const deployer = new Account(deployerId, provider, KeyPairSigner.fromSecretKey(deployerKey.toString()));

async function accountInfo(accountId) {
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
  return payload.result ?? null;
}

async function createAccount({ accountId, publicKey, fund, code, methodName, args }) {
  const existing = await accountInfo(accountId);
  if (existing) throw new Error(`${accountId} already exists; refusing to overwrite`);
  const actionList = [
    actions.createAccount(),
    actions.transfer(fund),
    actions.addFullAccessKey(publicKey),
  ];
  if (code) actionList.push(actions.deployContract(code));
  if (methodName) {
    actionList.push(
      actions.functionCall(methodName, args, 100_000_000_000_000n, 0n),
    );
  }
  const result = await deployer.signAndSendTransaction({
    receiverId: accountId,
    actions: actionList,
    waitUntil: "FINAL",
  });
  console.log("created", accountId, result.transaction?.hash);
}

async function view(accountId, methodName, args = {}) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: accountId,
        method_name: methodName,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message);
  return Buffer.from(payload.result?.result ?? []).toString();
}

const deployerInfo = await accountInfo(deployerId);
if (!deployerInfo) throw new Error(`deployer ${deployerId} does not exist on mainnet`);
const deployerNear = Number(deployerInfo.amount) / 1e24;
const requiredNear = Number(REGISTRY_FUND + MARKET_FUND + OWNER_FUND + ORACLE_FUND + FEES_FUND) / 1e24;
console.log("deployer", deployerId, deployerNear.toFixed(4), "NEAR");
console.log("required", requiredNear.toFixed(2), "NEAR + gas");
console.log("registry", registryId);
console.log("market", marketId);
console.log("owner", ownerId);
console.log("oracle", oracleId);
console.log("fees", feesId);

if (process.env.MAINNET_CONFIRM !== "DEPLOY") {
  console.log("dry run: set MAINNET_CONFIRM=DEPLOY to send mainnet transactions");
  process.exit(0);
}
if (Number(deployerInfo.amount) < (REGISTRY_FUND + MARKET_FUND + OWNER_FUND + ORACLE_FUND + FEES_FUND)) {
  throw new Error(`deployer needs more NEAR; have ${deployerNear.toFixed(4)}, need ${requiredNear.toFixed(2)}+`);
}

const ownerPublicKey = ownerKey.getPublicKey();
const oraclePublicKey = oracleKey.getPublicKey();
const oracleBytes = Array.from(deedPublicKey);

await createAccount({
  accountId: ownerId,
  publicKey: ownerPublicKey,
  fund: OWNER_FUND,
});
await createAccount({
  accountId: oracleId,
  publicKey: oraclePublicKey,
  fund: ORACLE_FUND,
});
await createAccount({
  accountId: feesId,
  publicKey: ownerPublicKey,
  fund: FEES_FUND,
});
await createAccount({
  accountId: registryId,
  publicKey: ownerPublicKey,
  fund: REGISTRY_FUND,
  code: registryCode,
  methodName: "new",
  args: { owner_id: ownerId, oracle_public_key: oracleBytes },
});
await createAccount({
  accountId: marketId,
  publicKey: ownerPublicKey,
  fund: MARKET_FUND,
  code: marketCode,
  methodName: "new",
  args: { owner_id: ownerId },
});

console.log("registry deeds", await view(registryId, "total_deeds"));
console.log("market count", await view(marketId, "get_markets", { from_index: 0, limit: 10 }));
console.log("owner key file", ownerKeyFile);
console.log("oracle NEAR key file", oracleKeyFile);
console.log("oracle deed seed file", oracleSeedFile);
console.log("Deployment complete. Set Render env:");
console.log("NEAR_NETWORK=mainnet");
console.log(`NEAR_CONTRACT_ID=${registryId}`);
console.log(`NEAR_MARKET_CONTRACT_ID=${marketId}`);
console.log(`NEAR_ORACLE_ACCOUNT_ID=${oracleId}`);
console.log(`PLATFORM_FEE_ADDRESS=${feesId}`);
console.log("MARKET_INITIAL_RESERVE_YOCTO=0");
