import crypto from "node:crypto";
import nacl from "tweetnacl";
import { PublicKey } from "near-api-js";
import { config } from "./config.js";
import { addSecondsIso, db, nowIso } from "./db.js";
import { ensureUserForWallet, randomId, type UserRow } from "./auth.js";
import { ApiError } from "./http.js";
import { rpcTargets } from "./rpc.js";

const NEP413_TAG = 2147484061;
const CHALLENGE_TTL_SECONDS = 10 * 60;
const ACCOUNT_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])$/;

async function hasActiveAccessKey(accountId: string, publicKey: string): Promise<boolean> {
  for (const target of rpcTargets()) {
    try {
      const response = await fetch(target.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...target.headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "query",
          params: {
            request_type: "view_access_key",
            finality: "final",
            account_id: accountId,
            public_key: publicKey,
          },
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as {
        result?: { nonce?: number | string; error?: string };
        error?: { cause?: { name?: string } };
      };
      if (payload.result?.error) return false;
      if (payload.result?.nonce !== undefined) return true;
      if (payload.error?.cause?.name === "UNKNOWN_ACCESS_KEY") return false;
    } catch {
    }
  }
  return false;
}

function u32le(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

function borshString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function nep413Hash(message: string, nonce: Buffer, recipient: string): Buffer {
  const payload = Buffer.concat([
    u32le(NEP413_TAG),
    borshString(message),
    nonce,
    borshString(recipient),
    Buffer.from([0]),
  ]);
  return crypto.createHash("sha256").update(payload).digest();
}

function decodeBase64(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

function validAccountId(accountId: string): boolean {
  return (
    accountId.length >= 2 &&
    accountId.length <= 64 &&
    ACCOUNT_ID_RE.test(accountId) &&
    !accountId.includes("..")
  );
}

export interface NearAuthChallenge {
  id: string;
  nonce: string;
  message: string;
  recipient: string;
  network: string;
  expiresAt: string;
}

export function createNearAuthChallenge(): NearAuthChallenge {
  const nonce = crypto.randomBytes(32);
  const recipient = config.nearAuthRecipient;
  const issuedAt = new Date().toISOString();
  const message = [
    "GitFi.fun wants you to sign in with your NEAR wallet.",
    "",
    `Nonce: ${nonce.toString("base64")}`,
    `Issued at: ${issuedAt}`,
    `Network: ${config.nearNetwork}`,
    `Site: gitfi.fun`,
    "",
    "This request will not trigger a blockchain transaction or cost any gas.",
  ].join("\n");
  const id = randomId("nchl_");
  const expiresAt = addSecondsIso(CHALLENGE_TTL_SECONDS);
  db.prepare(
    `INSERT INTO near_auth_challenges(id, nonce_b64, message, recipient, network, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, nonce.toString("base64"), message, recipient, config.nearNetwork, expiresAt, issuedAt);
  return {
    id,
    nonce: nonce.toString("base64"),
    message,
    recipient,
    network: config.nearNetwork,
    expiresAt,
  };
}

export interface NearAuthInput {
  challengeId: string;
  accountId: string;
  publicKey: string;
  signature: string;
  referredBy?: string | null;
}

export async function verifyNearAuthChallenge(input: NearAuthInput): Promise<{
  user: UserRow;
  created: boolean;
  accountId: string;
}> {
  const challenge = db
    .prepare("SELECT * FROM near_auth_challenges WHERE id = ? AND used_at IS NULL")
    .get(input.challengeId) as
    | {
        id: string;
        nonce_b64: string;
        message: string;
        recipient: string;
        network: string;
        expires_at: string;
      }
    | undefined;
  if (!challenge) {
    throw new ApiError("Sign-in request not found or already used.", 401, "CHALLENGE_NOT_FOUND");
  }
  if (challenge.expires_at < nowIso()) {
    throw new ApiError("This sign-in request expired. Try again.", 401, "CHALLENGE_EXPIRED");
  }
  if (challenge.network !== config.nearNetwork) {
    throw new ApiError(
      `This sign-in request belongs to NEAR ${challenge.network}. Refresh the page and sign in on NEAR ${config.nearNetwork}.`,
      401,
      "NETWORK_MISMATCH",
    );
  }

  const accountId = input.accountId.trim().toLowerCase();
  if (!validAccountId(accountId)) {
    throw new ApiError("That is not a valid NEAR account ID.", 400, "INVALID_ACCOUNT");
  }
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(input.publicKey)) {
    throw new ApiError(
      "Only Ed25519 NEAR wallets are supported for this login.",
      400,
      "UNSUPPORTED_KEY",
    );
  }

  let key: PublicKey;
  try {
    key = PublicKey.fromString(input.publicKey);
  } catch {
    throw new ApiError("The wallet returned an invalid public key.", 400, "INVALID_PUBLIC_KEY");
  }
  if (key.data.length !== 32) {
    throw new ApiError("The wallet returned an invalid Ed25519 key.", 400, "INVALID_PUBLIC_KEY");
  }

  const signature = decodeBase64(input.signature);
  if (signature.length !== 64) {
    throw new ApiError("The wallet returned a malformed signature.", 400, "INVALID_SIGNATURE");
  }
  const nonce = decodeBase64(challenge.nonce_b64);
  if (nonce.length !== 32) {
    throw new ApiError("Stored challenge nonce is invalid.", 500, "INVALID_CHALLENGE");
  }
  const hash = nep413Hash(challenge.message, nonce, challenge.recipient);
  const valid = nacl.sign.detached.verify(hash, signature, Buffer.from(key.data));
  if (!valid) {
    throw new ApiError("Wallet signature could not be verified.", 401, "INVALID_SIGNATURE");
  }

  const keyIsActive = await hasActiveAccessKey(accountId, input.publicKey);
  if (!keyIsActive) {
    throw new ApiError(
      `This key is not an active access key for ${accountId} on NEAR ${challenge.network}.`,
      401,
      "KEY_NOT_ON_ACCOUNT",
    );
  }

  db.prepare("UPDATE near_auth_challenges SET used_at = ? WHERE id = ?").run(nowIso(), challenge.id);
  const result = ensureUserForWallet({
    address: accountId,
    publicKey: input.publicKey,
    isSandbox: false,
    referredBy: input.referredBy,
    allowKeyRotation: true,
  });
  return { ...result, accountId };
}
