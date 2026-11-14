import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import nacl from "tweetnacl";
import { config } from "./config.js";
import { addSecondsIso, db, nowIso } from "./db.js";
import type { UserProfile } from "../shared/types.js";

declare global {
  namespace Express {
    interface Request {
      user?: UserRow;
      sessionHash?: string;
    }
  }
}

export interface UserRow {
  id: string;
  address: string;
  public_key: string | null;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  xp: number;
  usd_micro: number;
  realized_pnl_micro: number;
  referrer_id: string | null;
  referral_code: string;
  is_sandbox: number;
  last_faucet_at: string | null;
  created_at: string;
  updated_at: string;
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function randomId(prefix = ""): string {
  return `${prefix}${crypto.randomBytes(12).toString("base64url")}`;
}

export function addressFromPublicKey(publicKeyHex: string): string {
  const digest = sha256(Buffer.from(publicKeyHex, "hex")).slice(0, 16);
  return `gitfi-${digest}.near`;
}

export function makeReferralCode(seed: string): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.createHash("sha256").update(seed).digest();
  let out = "";
  for (let i = 0; i < 7; i += 1) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

export function displayNameForAccount(address: string): string {
  const base = address
    .replace(/\.(testnet|near|tg|aurora|mainnet)$/i, "")
    .replace(/[^a-z0-9_.-]/gi, "")
    .slice(0, 28);
  return base.length >= 2 ? base : `builder_${address.slice(0, 6)}`;
}

export function ensureUserForWallet(input: {
  address: string;
  publicKey: string;
  isSandbox: boolean;
  referredBy?: string | null;
  allowKeyRotation?: boolean;
}): { user: UserRow; created: boolean } {
  const existing = db
    .prepare("SELECT * FROM users WHERE address = ?")
    .get(input.address) as UserRow | undefined;
  if (existing) {
    if (
      !input.allowKeyRotation &&
      existing.public_key &&
      existing.public_key.toLowerCase() !== input.publicKey.toLowerCase()
    ) {
      throw new Error("This wallet address is already bound to another key.");
    }
    if (
      input.allowKeyRotation &&
      existing.public_key?.toLowerCase() !== input.publicKey.toLowerCase()
    ) {
      db.prepare("UPDATE users SET public_key = ?, updated_at = ? WHERE id = ?").run(
        input.publicKey,
        nowIso(),
        existing.id,
      );
    }
    return { user: existing, created: false };
  }

  let referrer: UserRow | undefined;
  if (input.referredBy) {
    referrer = db
      .prepare("SELECT * FROM users WHERE referral_code = ?")
      .get(input.referredBy.toUpperCase()) as UserRow | undefined;
  }
  const now = nowIso();
  const id = randomId("usr_");
  let referralCode = makeReferralCode(input.publicKey + now);
  while (db.prepare("SELECT 1 FROM users WHERE referral_code = ?").get(referralCode)) {
    referralCode = makeReferralCode(crypto.randomBytes(8).toString("hex"));
  }
  const display = input.isSandbox
    ? `builder_${input.address.slice(6, 10)}`
    : displayNameForAccount(input.address);
  const signupAirdrop = 0;
  db.prepare(
    `INSERT INTO users(id, address, public_key, display_name, xp, usd_micro, referral_code, referrer_id, is_sandbox, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.address,
    input.publicKey,
    display,
    100,
    signupAirdrop,
    referralCode,
    referrer?.id ?? null,
    input.isSandbox ? 1 : 0,
    now,
    now,
  );
  if (referrer) {
    db.prepare("UPDATE users SET xp = xp + 150 WHERE id = ?").run(referrer.id);
    db.prepare(
      `INSERT INTO activities(id, type, actor_wallet, message, metadata_json, created_at)
       VALUES (?, 'verify', ?, ?, '{}', ?)`,
    ).run(randomId("act_"), input.address, `joined via ${referrer.display_name}'s referral`, now);
  }
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as UserRow;
  return { user, created: true };
}

export function userProfile(row: UserRow): UserProfile {
  const pnl = db
    .prepare(
      `SELECT COALESCE(SUM(h.amount_micro * t.last_price_micro / 1000000 - h.cost_micro), 0) + ? AS pnl
       FROM holdings h JOIN tokens t ON t.id = h.token_id WHERE h.user_id = ?`,
    )
    .get(row.realized_pnl_micro, row.id) as { pnl: number };
  return {
    id: row.id,
    address: row.address,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    xp: row.xp,
    usdMicro: row.usd_micro,
    pnlMicro: Math.round(Number(pnl.pnl)),
    referralCode: row.referral_code,
    referredBy: row.referrer_id,
    createdAt: row.created_at,
    isSandbox: Boolean(row.is_sandbox),
  };
}

export function createSession(userId: string, userAgent?: string): string {
  const raw = crypto.randomBytes(32).toString("base64url");
  const hash = sha256(raw);
  db.prepare(
    `INSERT INTO sessions(token_hash, user_id, network, user_agent, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(hash, userId, config.nearNetwork, userAgent ?? null, nowIso(), addSecondsIso(60 * 60 * 24 * 30));
  return raw;
}

export function setSessionCookie(res: Response, raw: string, secure = false): void {
  res.cookie(config.cookieName, raw, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 1000 * 60 * 60 * 24 * 30,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(config.cookieName, { path: "/" });
}

export function getSessionUser(req: Request): UserRow | null {
  const raw = req.cookies?.[config.cookieName] as string | undefined;
  if (!raw) return null;
  const user = userForSessionRaw(raw);
  if (!user) return null;
  req.sessionHash = sha256(raw);
  return user;
}

export function userForSessionRaw(raw: string): UserRow | null {
  if (!raw) return null;
  const hash = sha256(raw);
  const row = db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND s.network = ?`,
    )
    .get(hash, nowIso(), config.nearNetwork) as UserRow | undefined;
  return row ?? null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  if (!header) return output;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      output[key] = decodeURIComponent(value);
    } catch {
      output[key] = value;
    }
  }
  return output;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Connect a wallet to continue.", code: "AUTH_REQUIRED" });
    return;
  }
  req.user = user;
  next();
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const user = getSessionUser(req);
  if (user) req.user = user;
  next();
}

export function createAuthChallenge(publicKey: string, referredBy?: string): {
  id: string;
  address: string;
  message: string;
  expiresAt: string;
} {
  if (!/^[a-f0-9]{64}$/i.test(publicKey)) {
    throw new Error("Public key must be 32 bytes of hex");
  }
  const address = addressFromPublicKey(publicKey);
  const nonce = crypto.randomBytes(24).toString("base64url");
  const issuedAt = new Date().toISOString();
  const message = [
    "GitFi.fun wants you to sign in with your NEAR wallet.",
    "",
    `Address: ${address}`,
    `Public key: ${publicKey}`,
    `Nonce: ${nonce}`,
    `Issued at: ${issuedAt}`,
    "Site: gitfi.fun",
    "",
    "This request will not trigger a blockchain transaction or cost any gas.",
    referredBy ? `Referral: ${referredBy}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const id = randomId("chl_");
  const expiresAt = addSecondsIso(60 * 10);
  db.prepare(
    `INSERT INTO auth_challenges(id, public_key, address, nonce, message, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, publicKey.toLowerCase(), address, nonce, message, expiresAt, issuedAt);
  return { id, address, message, expiresAt };
}

export function verifyAuthChallenge(
  challengeId: string,
  signatureHex: string,
  referredBy?: string,
): { user: UserRow; created: boolean } {
  const challenge = db
    .prepare("SELECT * FROM auth_challenges WHERE id = ? AND used_at IS NULL")
    .get(challengeId) as
    | {
        id: string;
        public_key: string;
        address: string;
        nonce: string;
        message: string;
        expires_at: string;
      }
    | undefined;
  if (!challenge) throw new Error("Sign-in request not found or already used.");
  if (challenge.expires_at < nowIso()) throw new Error("This sign-in request expired. Try again.");
  if (!/^[a-f0-9]{128}$/i.test(signatureHex)) throw new Error("Malformed signature.");
  const valid = nacl.sign.detached.verify(
    Buffer.from(challenge.message),
    Buffer.from(signatureHex, "hex"),
    Buffer.from(challenge.public_key, "hex"),
  );
  if (!valid) throw new Error("Wallet signature could not be verified.");
  db.prepare("UPDATE auth_challenges SET used_at = ? WHERE id = ?").run(nowIso(), challenge.id);

  return ensureUserForWallet({
    address: challenge.address,
    publicKey: challenge.public_key,
    isSandbox: true,
    referredBy,
  });
}

