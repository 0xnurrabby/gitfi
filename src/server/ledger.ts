import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import nacl from "tweetnacl";
import { dataDir, db, nowIso } from "./db.js";
import { log } from "./config.js";

interface OracleKey {
  seedHex: string;
  publicKeyHex: string;
  secretKeyHex: string;
}

let cachedKey: OracleKey | null = null;

export function oracleKey(): OracleKey {
  if (cachedKey) return cachedKey;
  const envSeed = process.env.ORACLE_SEED_HEX?.trim();
  if (envSeed && /^[0-9a-f]{64}$/i.test(envSeed)) {
    const seed = Buffer.from(envSeed, "hex");
    const pair = nacl.sign.keyPair.fromSeed(seed);
    cachedKey = {
      seedHex: envSeed.toLowerCase(),
      publicKeyHex: Buffer.from(pair.publicKey).toString("hex"),
      secretKeyHex: Buffer.from(pair.secretKey).toString("hex"),
    };
    return cachedKey;
  }
  const file = path.join(dataDir, "oracle-key.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as OracleKey;
    if (parsed.seedHex && parsed.publicKeyHex && parsed.secretKeyHex) {
      cachedKey = parsed;
      return parsed;
    }
  } catch {
    // Generate a deterministic-per-install oracle key.
  }
  const seed = crypto.randomBytes(32);
  const pair = nacl.sign.keyPair.fromSeed(seed);
  const key: OracleKey = {
    seedHex: Buffer.from(seed).toString("hex"),
    publicKeyHex: Buffer.from(pair.publicKey).toString("hex"),
    secretKeyHex: Buffer.from(pair.secretKey).toString("hex"),
  };
  fs.writeFileSync(file, JSON.stringify(key, null, 2), { mode: 0o600 });
  cachedKey = key;
  log(`oracle public key ${key.publicKeyHex.slice(0, 16)}…`);
  return key;
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function signBytes(message: string | Buffer): string {
  const key = oracleKey();
  const sig = nacl.sign.detached(
    Buffer.from(message),
    Buffer.from(key.secretKeyHex, "hex"),
  );
  return Buffer.from(sig).toString("hex");
}

export function verifyOracleSignature(message: string | Buffer, signatureHex: string): boolean {
  try {
    return nacl.sign.detached.verify(
      Buffer.from(message),
      Buffer.from(signatureHex, "hex"),
      Buffer.from(oracleKey().publicKeyHex, "hex"),
    );
  } catch {
    return false;
  }
}

export interface ChainReceipt {
  seq: number;
  id: string;
  type: string;
  aggregate: string;
  payloadJson: string;
  digest: string;
  prevDigest: string;
  oraclePublicKey: string;
  oracleSignature: string;
  createdAt: string;
}

const GENESIS = sha256Hex("gitfi.fun/genesis/v1");

export function appendReceipt(
  type: string,
  aggregate: string,
  payload: Record<string, unknown>,
): ChainReceipt {
  const last = db
    .prepare("SELECT digest FROM chain_receipts ORDER BY seq DESC LIMIT 1")
    .get() as { digest: string } | undefined;
  const prevDigest = last?.digest ?? GENESIS;
  const createdAt = nowIso();
  const payloadJson = JSON.stringify(payload);
  const digest = sha256Hex(`${prevDigest}|${type}|${aggregate}|${payloadJson}|${createdAt}`);
  const signature = signBytes(digest);
  const key = oracleKey();
  const id = `rcpt_${crypto.randomBytes(12).toString("base64url")}`;
  const result = db
    .prepare(
      `INSERT INTO chain_receipts(id, type, aggregate, payload_json, digest, prev_digest, oracle_public_key, oracle_signature, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, type, aggregate, payloadJson, digest, prevDigest, key.publicKeyHex, signature, createdAt);
  return {
    seq: Number(result.lastInsertRowid),
    id,
    type,
    aggregate,
    payloadJson,
    digest,
    prevDigest,
    oraclePublicKey: key.publicKeyHex,
    oracleSignature: signature,
    createdAt,
  };
}

export interface ChainVerification {
  valid: boolean;
  receipts: number;
  head: string | null;
  brokenAt: string | null;
  oraclePublicKey: string;
}

export function verifyChain(): ChainVerification {
  const rows = db
    .prepare("SELECT * FROM chain_receipts ORDER BY seq ASC")
    .all() as Array<{
    seq: number;
    type: string;
    aggregate: string;
    payload_json: string;
    digest: string;
    prev_digest: string;
    oracle_public_key: string;
    oracle_signature: string;
    created_at: string;
  }>;
  let prev = GENESIS;
  for (const row of rows) {
    if (row.prev_digest !== prev) {
      return {
        valid: false,
        receipts: rows.length,
        head: prev,
        brokenAt: String(row.seq),
        oraclePublicKey: oracleKey().publicKeyHex,
      };
    }
    const digest = sha256Hex(
      `${row.prev_digest}|${row.type}|${row.aggregate}|${row.payload_json}|${row.created_at}`,
    );
    if (digest !== row.digest || !verifyOracleSignature(row.digest, row.oracle_signature)) {
      return {
        valid: false,
        receipts: rows.length,
        head: prev,
        brokenAt: String(row.seq),
        oraclePublicKey: oracleKey().publicKeyHex,
      };
    }
    prev = row.digest;
  }
  return {
    valid: true,
    receipts: rows.length,
    head: rows.length > 0 ? prev : null,
    brokenAt: null,
    oraclePublicKey: oracleKey().publicKeyHex,
  };
}

export function receiptView(row: {
  seq: number;
  id: string;
  type: string;
  aggregate: string;
  digest: string;
  created_at: string;
}): Record<string, unknown> {
  return {
    seq: row.seq,
    id: row.id,
    type: row.type,
    aggregate: row.aggregate,
    digest: row.digest,
    createdAt: row.created_at,
  };
}
