import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import nacl from "tweetnacl";
import {
  Account,
  JsonRpcProvider,
  KeyPairSigner,
  actions,
  formatNearAmount,
  type KeyPairString,
} from "near-api-js";
import { config, log, warn } from "./config.js";
import { db, nowIso } from "./db.js";
import { oracleKey } from "./ledger.js";
import { rpcTarget } from "./rpc.js";

const GAS = 100_000_000_000_000n;
const MAX_REPO_LEN = 200;
const MAX_METADATA_LEN = 512;

export type ChainTxStatus = "pending" | "submitted" | "confirmed" | "failed" | "skipped";

export interface ChainTx {
  id: string;
  kind: string;
  aggregate: string;
  subjectId: string | null;
  network: string;
  contractId: string;
  method: string;
  txHash: string | null;
  status: ChainTxStatus;
  error: string | null;
  explorerUrl: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

export interface ChainStatus {
  enabled: boolean;
  ready: boolean;
  network: string;
  rpcUrl: string;
  contractId: string;
  accountId: string;
  explorerUrl: string;
  contractUrl: string;
  reason: string | null;
  balanceNear: string | null;
  paused: boolean | null;
  totalDeeds: number | null;
  oracleMatches: boolean | null;
  txs: ChainTx[];
  anchors: number;
  deeds: number;
  lastAnchorAt: string | null;
}

interface ChainTxRow {
  id: string;
  kind: string;
  aggregate: string;
  subject_id: string | null;
  network: string;
  contract_id: string;
  method: string;
  args_json: string;
  tx_hash: string | null;
  status: ChainTxStatus;
  error: string | null;
  explorer_url: string | null;
  created_at: string;
  confirmed_at: string | null;
}

function rowToChainTx(row: ChainTxRow): ChainTx {
  return {
    id: row.id,
    kind: row.kind,
    aggregate: row.aggregate,
    subjectId: row.subject_id,
    network: row.network,
    contractId: row.contract_id,
    method: row.method,
    txHash: row.tx_hash,
    status: row.status,
    error: row.error,
    explorerUrl: row.explorer_url,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
  };
}

// ----------------------------- Borsh envelope -----------------------------

function u32le(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

function u64le(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value, 0);
  return out;
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u32le(bytes.length), bytes]);
}

function borshOptionString(value: string | null): Buffer {
  return value ? Buffer.concat([Buffer.from([1]), borshString(value)]) : Buffer.from([0]);
}

function issuedAtNs(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function deedEnvelope(input: {
  repo: string;
  tokenId: string;
  owner: string | null;
  metadataUri: string;
}): { bytes: Buffer; nonce: number[]; issuedAt: string; signature: number[] } {
  const nonce = crypto.randomBytes(32);
  const issuedAt = issuedAtNs();
  const bytes = Buffer.concat([
    borshString(input.repo.toLowerCase()),
    borshString(input.tokenId),
    borshOptionString(input.owner),
    borshString(input.metadataUri),
    nonce,
    u64le(BigInt(issuedAt)),
  ]);
  const signature = nacl.sign.detached(bytes, Buffer.from(oracleKey().secretKeyHex, "hex"));
  return {
    bytes,
    nonce: Array.from(nonce),
    issuedAt,
    signature: Array.from(signature),
  };
}

function anchorEnvelope(input: {
  kind: string;
  aggregate: string;
  digest: string;
}): { nonce: number[]; issuedAt: string; signature: number[] } {
  const nonce = crypto.randomBytes(32);
  const issuedAt = issuedAtNs();
  const bytes = Buffer.concat([
    borshString(input.kind),
    borshString(input.aggregate),
    borshString(input.digest),
    nonce,
    u64le(BigInt(issuedAt)),
  ]);
  const signature = nacl.sign.detached(bytes, Buffer.from(oracleKey().secretKeyHex, "hex"));
  return { nonce: Array.from(nonce), issuedAt, signature: Array.from(signature) };
}

// ----------------------------- Credentials / client -----------------------------

let provider: JsonRpcProvider | null = null;
let account: Account | null = null;
let initError: string | null = null;
let initialized = false;

function credentialFile(): string {
  return path.join(
    config.nearCredentialsDir,
    config.nearNetwork,
    `${config.nearOracleAccountId}.json`,
  );
}

function loadPrivateKey(): string {
  if (config.nearOraclePrivateKey) return config.nearOraclePrivateKey;
  const file = credentialFile();
  if (!fs.existsSync(file)) {
    throw new Error(
      `NEAR credentials not found at ${file}. Set NEAR_ORACLE_PRIVATE_KEY or NEAR_CREDENTIALS_DIR.`,
    );
  }
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw) as {
    private_key?: string;
    secret_key?: string;
    account_id?: string;
    public_key?: string;
  };
  const key = parsed.private_key ?? parsed.secret_key;
  if (!key) throw new Error("NEAR credential file has no private_key.");
  if (parsed.account_id && parsed.account_id !== config.nearOracleAccountId) {
    throw new Error(
      `NEAR credential account ${parsed.account_id} does not match NEAR_ORACLE_ACCOUNT_ID ${config.nearOracleAccountId}.`,
    );
  }
  return key;
}

function initChain(): { account: Account; provider: JsonRpcProvider } | null {
  if (initialized) {
    return account && provider ? { account, provider } : null;
  }
  initialized = true;
  if (!config.nearChainEnabled) {
    initError = "NEAR chain bridge disabled (NEAR_CHAIN_ENABLED=false).";
    return null;
  }
  if (!config.nearContractId) {
    initError = "NEAR_CONTRACT_ID is not configured.";
    return null;
  }
  try {
    const privateKey = loadPrivateKey();
    const connection = rpcTarget();
    provider = new JsonRpcProvider(
      { url: connection.url, headers: connection.headers },
      { retries: 4, wait: 400, backoff: 1.6 },
    );
    const signer = KeyPairSigner.fromSecretKey(privateKey as KeyPairString);
    account = new Account(config.nearOracleAccountId, provider, signer);
    log(
      `NEAR ${config.nearNetwork} bridge ready · ${config.nearOracleAccountId} → ${config.nearContractId}`,
    );
    return { account, provider };
  } catch (error) {
    initError = (error as Error).message;
    warn(`NEAR bridge unavailable: ${initError}`);
    return null;
  }
}

export function chainEnabled(): boolean {
  return initChain() !== null;
}

export function chainUnavailableReason(): string | null {
  initChain();
  return initError;
}

function explorerTx(txHash: string): string {
  return `${config.nearExplorerUrl.replace(/\/$/, "")}/transactions/${txHash}`;
}

function contractUrl(): string {
  return `${config.nearExplorerUrl.replace(/\/$/, "")}/accounts/${config.nearContractId}`;
}

// ----------------------------- Persistence -----------------------------

function insertTx(input: {
  kind: string;
  aggregate: string;
  subjectId?: string | null;
  method: string;
  args: Record<string, unknown>;
}): ChainTx {
  const id = `ctx_${crypto.randomBytes(11).toString("base64url")}`;
  const now = nowIso();
  const row: ChainTxRow = {
    id,
    kind: input.kind,
    aggregate: input.aggregate,
    subject_id: input.subjectId ?? null,
    network: config.nearNetwork,
    contract_id: config.nearContractId,
    method: input.method,
    args_json: JSON.stringify(input.args),
    tx_hash: null,
    status: "pending",
    error: null,
    explorer_url: null,
    created_at: now,
    confirmed_at: null,
  };
  db.prepare(
    `INSERT INTO chain_txs(
      id, kind, aggregate, subject_id, network, contract_id, method, args_json,
      tx_hash, status, error, explorer_url, created_at, confirmed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.kind,
    row.aggregate,
    row.subject_id,
    row.network,
    row.contract_id,
    row.method,
    row.args_json,
    row.tx_hash,
    row.status,
    row.error,
    row.explorer_url,
    row.created_at,
    row.confirmed_at,
  );
  return rowToChainTx(row);
}

function getTxRow(id: string): ChainTxRow | null {
  return (db.prepare("SELECT * FROM chain_txs WHERE id = ?").get(id) as ChainTxRow | undefined) ?? null;
}

function setTxState(
  id: string,
  state: {
    status: ChainTxStatus;
    txHash?: string | null;
    error?: string | null;
  },
): ChainTx {
  const confirmedAt = state.status === "confirmed" ? nowIso() : null;
  db.prepare(
    `UPDATE chain_txs
       SET status = ?, tx_hash = COALESCE(?, tx_hash), error = ?, explorer_url = COALESCE(?, explorer_url), confirmed_at = ?
     WHERE id = ?`,
  ).run(
    state.status,
    state.txHash ?? null,
    state.error ?? null,
    state.txHash ? explorerTx(state.txHash) : null,
    confirmedAt,
    id,
  );
  return rowToChainTx(getTxRow(id)!);
}

function extractTxHash(result: unknown): string | null {
  const value = result as {
    transaction?: { hash?: string };
    transaction_outcome?: { id?: string };
    transactionResult?: { transaction?: { hash?: string } };
  };
  return (
    value.transaction?.hash ??
    value.transaction_outcome?.id ??
    value.transactionResult?.transaction?.hash ??
    null
  );
}

let serial: Promise<unknown> = Promise.resolve();

function runSerial<T>(task: () => Promise<T>): Promise<T> {
  const next = serial.then(task, task);
  serial = next.catch(() => undefined);
  return next;
}

async function submitTx(id: string): Promise<ChainTx> {
  const row = getTxRow(id);
  if (!row) throw new Error(`chain tx ${id} not found`);
  if (row.status === "confirmed" || row.status === "skipped") return rowToChainTx(row);
  const client = initChain();
  if (!client) {
    return setTxState(id, {
      status: "skipped",
      error: initError ?? "NEAR bridge unavailable.",
    });
  }
  setTxState(id, { status: "pending", error: null });
  try {
    const args = JSON.parse(row.args_json) as Record<string, unknown>;
    const result = await runSerial(() =>
      client.account.callFunctionRaw({
        contractId: row.contract_id,
        methodName: row.method,
        args,
        gas: GAS,
        deposit: 0n,
        waitUntil: "EXECUTED_OPTIMISTIC",
      }),
    );
    const txHash = extractTxHash(result);
    if (!txHash) {
      return setTxState(id, {
        status: "submitted",
        error: "Transaction accepted but the RPC response did not include a hash.",
      });
    }
    log(`NEAR ${row.method} ${row.kind} confirmed · ${txHash}`);
    return setTxState(id, { status: "confirmed", txHash, error: null });
  } catch (error) {
    const message = (error as Error).message.slice(0, 500);
    warn(`NEAR ${row.method} failed: ${message}`);
    return setTxState(id, { status: "failed", error: message });
  }
}

// ----------------------------- Public chain actions -----------------------------

export interface DeedInput {
  repo: string;
  tokenId: string;
  owner: string | null;
  metadataUri: string;
  subjectId?: string | null;
}

function normalizeRepo(repo: string): string {
  const value = repo.trim().toLowerCase();
  if (value.length > MAX_REPO_LEN) throw new Error("repository identifier too long");
  return value;
}

export function queueDeedMint(input: DeedInput): ChainTx | null {
  if (!chainEnabled()) return null;
  const repo = normalizeRepo(input.repo);
  const metadataUri = input.metadataUri.slice(0, MAX_METADATA_LEN);
  const envelope = deedEnvelope({
    repo,
    tokenId: input.tokenId,
    owner: input.owner,
    metadataUri,
  });
  const tx = insertTx({
    kind: "deed.mint",
    aggregate: repo,
    subjectId: input.subjectId ?? input.tokenId,
    method: "mint_repo_deed",
    args: {
      repo,
      token_id: input.tokenId,
      owner: input.owner,
      metadata_uri: metadataUri,
      nonce: envelope.nonce,
      issued_at: envelope.issuedAt,
      signature: envelope.signature,
    },
  });
  void submitTx(tx.id);
  return tx;
}

export function mintDeedAndWait(input: DeedInput, timeoutMs = 20_000): Promise<ChainTx | null> {
  const tx = queueDeedMint(input);
  if (!tx) return Promise.resolve(null);
  return waitForChainTx(tx.id, timeoutMs);
}

export function queueDeedClaim(input: {
  repo: string;
  tokenId: string;
  newOwner: string;
  metadataUri: string;
  subjectId?: string | null;
}): ChainTx | null {
  if (!chainEnabled()) return null;
  const repo = normalizeRepo(input.repo);
  const metadataUri = input.metadataUri.slice(0, MAX_METADATA_LEN);
  const envelope = deedEnvelope({
    repo,
    tokenId: input.tokenId,
    owner: input.newOwner,
    metadataUri,
  });
  const tx = insertTx({
    kind: "deed.claim",
    aggregate: repo,
    subjectId: input.subjectId ?? input.tokenId,
    method: "claim_repo_deed",
    args: {
      repo,
      token_id: input.tokenId,
      new_owner: input.newOwner,
      metadata_uri: metadataUri,
      nonce: envelope.nonce,
      issued_at: envelope.issuedAt,
      signature: envelope.signature,
    },
  });
  void submitTx(tx.id);
  return tx;
}

export function claimDeedAndWait(
  input: {
    repo: string;
    tokenId: string;
    newOwner: string;
    metadataUri: string;
    subjectId?: string | null;
  },
  timeoutMs = 20_000,
): Promise<ChainTx | null> {
  const tx = queueDeedClaim(input);
  if (!tx) return Promise.resolve(null);
  return waitForChainTx(tx.id, timeoutMs);
}

function queueDeedReassign(input: {
  repo: string;
  tokenId: string;
  newOwner: string;
  metadataUri: string;
  subjectId?: string | null;
}): ChainTx | null {
  if (!chainEnabled()) return null;
  const repo = normalizeRepo(input.repo);
  const metadataUri = input.metadataUri.slice(0, MAX_METADATA_LEN);
  const envelope = deedEnvelope({
    repo,
    tokenId: input.tokenId,
    owner: input.newOwner,
    metadataUri,
  });
  const tx = insertTx({
    kind: "deed.reassign",
    aggregate: repo,
    subjectId: input.subjectId ?? input.tokenId,
    method: "reassign_deed",
    args: {
      repo,
      token_id: input.tokenId,
      new_owner: input.newOwner,
      metadata_uri: metadataUri,
      nonce: envelope.nonce,
      issued_at: envelope.issuedAt,
      signature: envelope.signature,
    },
  });
  void submitTx(tx.id);
  return tx;
}

export function reassignDeedAndWait(
  input: {
    repo: string;
    tokenId: string;
    newOwner: string;
    metadataUri: string;
    subjectId?: string | null;
  },
  timeoutMs = 20_000,
): Promise<ChainTx | null> {
  const tx = queueDeedReassign(input);
  if (!tx) return Promise.resolve(null);
  return waitForChainTx(tx.id, timeoutMs);
}

export function queueDeedFreeze(input: {
  tokenId: string;
  frozen: boolean;
  subjectId?: string | null;
}): ChainTx | null {
  if (!chainEnabled()) return null;
  const tx = insertTx({
    kind: input.frozen ? "deed.freeze" : "deed.unfreeze",
    aggregate: input.tokenId,
    subjectId: input.subjectId ?? input.tokenId,
    method: "set_frozen",
    args: { token_id: input.tokenId, frozen: input.frozen },
  });
  void submitTx(tx.id);
  return tx;
}

export function queueReceiptAnchor(input: {
  kind: string;
  aggregate: string;
  digest: string;
  subjectId?: string | null;
}): ChainTx | null {
  try {
    return queueReceiptAnchorUnsafe(input);
  } catch (error) {
    warn(`NEAR receipt anchor queue failed: ${(error as Error).message}`);
    return null;
  }
}

function queueReceiptAnchorUnsafe(input: {
  kind: string;
  aggregate: string;
  digest: string;
  subjectId?: string | null;
}): ChainTx | null {
  if (!chainEnabled()) return null;
  if (!/^[0-9a-f]{64}$/i.test(input.digest)) return null;
  const existing = db
    .prepare("SELECT id, status FROM chain_txs WHERE kind = ? AND aggregate = ? AND method = 'anchor_event' AND args_json LIKE ? ORDER BY created_at DESC LIMIT 1")
    .get(input.kind, input.aggregate, `%${input.digest}%`) as { id: string; status: string } | undefined;
  if (existing && existing.status !== "failed") {
    return rowToChainTx(getTxRow(existing.id)!);
  }
  const envelope = anchorEnvelope(input);
  const tx = insertTx({
    kind: input.kind,
    aggregate: input.aggregate,
    subjectId: input.subjectId ?? null,
    method: "anchor_event",
    args: {
      kind: input.kind,
      aggregate: input.aggregate,
      digest: input.digest,
      nonce: envelope.nonce,
      issued_at: envelope.issuedAt,
      signature: envelope.signature,
    },
  });
  void submitTx(tx.id);
  return tx;
}

export function waitForChainTx(id: string, timeoutMs = 20_000): Promise<ChainTx | null> {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const row = getTxRow(id);
      if (!row) {
        resolve(null);
        return;
      }
      if (row.status === "confirmed" || row.status === "failed" || row.status === "skipped") {
        resolve(rowToChainTx(row));
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        resolve(rowToChainTx(row));
        return;
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

// ----------------------------- Reads -----------------------------

export function latestChainTx(kind: string, aggregate: string): ChainTx | null {
  const row = db
    .prepare(
      "SELECT * FROM chain_txs WHERE kind = ? AND aggregate = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(kind, aggregate) as ChainTxRow | undefined;
  return row ? rowToChainTx(row) : null;
}

export function latestChainTxsForSubject(subjectId: string, limit = 8): ChainTx[] {
  const rows = db
    .prepare(
      "SELECT * FROM chain_txs WHERE subject_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(subjectId, limit) as unknown as ChainTxRow[];
  return rows.map(rowToChainTx);
}

export function recentChainTxs(limit = 20): ChainTx[] {
  const rows = db
    .prepare("SELECT * FROM chain_txs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as ChainTxRow[];
  return rows.map(rowToChainTx);
}

export async function chainStatus(): Promise<ChainStatus> {
  const client = initChain();
  const base: ChainStatus = {
    enabled: config.nearChainEnabled,
    ready: client !== null,
    network: config.nearNetwork,
    rpcUrl: config.nearRpcUrl,
    contractId: config.nearContractId,
    accountId: config.nearOracleAccountId,
    explorerUrl: config.nearExplorerUrl,
    contractUrl: contractUrl(),
    reason: initError,
    balanceNear: null,
    paused: null,
    totalDeeds: null,
    oracleMatches: null,
    txs: recentChainTxs(20),
    anchors: (
      db.prepare("SELECT COUNT(*) AS count FROM chain_txs WHERE method = 'anchor_event' AND status = 'confirmed'").get() as {
        count: number;
      }
    ).count,
    deeds: (
      db.prepare("SELECT COUNT(*) AS count FROM chain_txs WHERE kind = 'deed.mint' AND status = 'confirmed'").get() as {
        count: number;
      }
    ).count,
    lastAnchorAt:
      (
        db
          .prepare(
            "SELECT confirmed_at FROM chain_txs WHERE method = 'anchor_event' AND status = 'confirmed' ORDER BY confirmed_at DESC LIMIT 1",
          )
          .get() as { confirmed_at: string } | undefined
      )?.confirmed_at ?? null,
  };
  if (!client) return base;
  try {
    const [view, paused, deeds, oracle] = await Promise.all([
      client.provider.viewAccount({
        accountId: config.nearOracleAccountId,
        blockQuery: { finality: "final" },
      }),
      client.provider.callFunction<boolean>({
        contractId: config.nearContractId,
        method: "is_paused",
        args: {},
        blockQuery: { finality: "final" },
      }),
      client.provider.callFunction<number>({
        contractId: config.nearContractId,
        method: "total_deeds",
        args: {},
        blockQuery: { finality: "final" },
      }),
      client.provider.callFunction<number[]>({
        contractId: config.nearContractId,
        method: "oracle_public_key",
        args: {},
        blockQuery: { finality: "final" },
      }),
    ]);
    const expected = Buffer.from(oracleKey().publicKeyHex, "hex");
    const onChain = Buffer.from(oracle ?? []);
    base.balanceNear = formatNearAmount(view.amount.toString(), 4);
    base.paused = paused ?? null;
    base.totalDeeds = deeds ?? null;
    base.oracleMatches = onChain.length === expected.length && onChain.equals(expected);
  } catch (error) {
    base.ready = false;
    base.reason = (error as Error).message;
  }
  return base;
}

// ----------------------------- Startup work -----------------------------

/**
 * Mint a Repo Deed for every market that predates the chain bridge. Demo
 * markets are minted escrowed: the oracle can release them to a verified owner
 * later without a private key being handed around.
 */
export function backfillDeeds(): void {
  if (!chainEnabled()) return;
  const rows = db
    .prepare(
      `SELECT t.id AS token_id, r.full_name AS repo, t.owner_wallet
         FROM tokens t JOIN repos r ON r.id = t.repo_id
        WHERE t.status IN ('prelaunch', 'bonding', 'live', 'graduated')
        ORDER BY t.created_at ASC`,
    )
    .all() as { token_id: string; repo: string; owner_wallet: string | null }[];
  let queued = 0;
  for (const row of rows) {
    const existing = db
      .prepare(
        "SELECT id, status FROM chain_txs WHERE kind = 'deed.mint' AND subject_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(row.token_id) as { id: string; status: string } | undefined;
    if (existing && existing.status !== "failed" && existing.status !== "skipped") continue;
    try {
      const tx = queueDeedMint({
        repo: row.repo,
        tokenId: row.token_id,
        owner: row.owner_wallet,
        metadataUri: `${config.appUrl.replace(/\/$/, "")}/api/nft/${row.token_id}/metadata`,
        subjectId: row.token_id,
      });
      if (tx) queued += 1;
    } catch (error) {
      warn(`could not queue ${row.repo} deed: ${(error as Error).message}`);
    }
  }
  if (queued > 0) log(`queued ${queued} Repo Deed mint${queued === 1 ? "" : "s"} on NEAR ${config.nearNetwork}`);
}

/**
 * Anchor the newest receipt of each material type for every existing market.
 * New activity is anchored live; this only fills the gap for markets that
 * predate the chain bridge. Dedupe happens by receipt digest.
 */
export function backfillAnchors(): void {
  if (!chainEnabled()) return;
  const tokens = db.prepare("SELECT id FROM tokens ORDER BY created_at ASC").all() as {
    id: string;
  }[];
  const kinds = ["token.mint", "ownership.claim", "token.graduate", "trade.settle", "star.milestone"] as const;
  let queued = 0;
  for (const token of tokens) {
    for (const kind of kinds) {
      const receipt = db
        .prepare(
          "SELECT digest FROM chain_receipts WHERE type = ? AND aggregate = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(kind, token.id) as { digest: string } | undefined;
      if (!receipt) continue;
      const already = db
        .prepare(
          "SELECT 1 FROM chain_txs WHERE method = 'anchor_event' AND kind = ? AND aggregate = ? AND args_json LIKE ? LIMIT 1",
        )
        .get(kind, token.id, `%${receipt.digest}%`);
      if (already) continue;
      const tx = queueReceiptAnchor({
        kind,
        aggregate: token.id,
        digest: receipt.digest,
        subjectId: token.id,
      });
      if (tx) queued += 1;
    }
  }
  if (queued > 0) log(`queued ${queued} receipt anchor${queued === 1 ? "" : "s"} on NEAR ${config.nearNetwork}`);
}
