import Database from "libsql";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

export const dataDir = path.resolve(process.env.GITFI_DATA_DIR ?? path.join(root, "data"));
export const uploadDir = path.join(dataDir, "uploads");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const tursoUrl = process.env.TURSO_DATABASE_URL?.trim();
const tursoToken = process.env.TURSO_AUTH_TOKEN?.trim();
export const usingTurso = Boolean(tursoUrl);

export const db = usingTurso
  ? new Database(
      tursoUrl!,
      { authToken: tursoToken } as unknown as ConstructorParameters<typeof Database>[1],
    )
  : new Database(path.join(dataDir, "gitfi.db"));

if (usingTurso) {
  // Remote libSQL only supports a subset of SQLite pragmas.
  db.exec("PRAGMA foreign_keys = ON;");
} else {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
  `);
}

const schema = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  public_key TEXT,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  bio TEXT,
  xp INTEGER NOT NULL DEFAULT 0,
  usd_micro INTEGER NOT NULL DEFAULT 0,
  realized_pnl_micro INTEGER NOT NULL DEFAULT 0,
  referrer_id TEXT REFERENCES users(id),
  referral_code TEXT NOT NULL UNIQUE,
  is_sandbox INTEGER NOT NULL DEFAULT 1,
  last_faucet_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  address TEXT NOT NULL,
  nonce TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS near_auth_challenges (
  id TEXT PRIMARY KEY,
  nonce_b64 TEXT NOT NULL,
  message TEXT NOT NULL,
  recipient TEXT NOT NULL,
  network TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  github_id INTEGER,
  full_name TEXT NOT NULL,
  full_name_lc TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  homepage TEXT,
  stars INTEGER NOT NULL DEFAULT 0,
  forks INTEGER NOT NULL DEFAULT 0,
  watchers INTEGER NOT NULL DEFAULT 0,
  open_issues INTEGER NOT NULL DEFAULT 0,
  language TEXT,
  topics_json TEXT NOT NULL DEFAULT '[]',
  license TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  github_created_at TEXT,
  pushed_at TEXT,
  commit_count INTEGER NOT NULL DEFAULT 0,
  last_commit_at TEXT,
  size_kb INTEGER NOT NULL DEFAULT 0,
  is_fork INTEGER NOT NULL DEFAULT 0,
  is_private INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  health_score INTEGER NOT NULL DEFAULT 50,
  star_velocity_1h INTEGER NOT NULL DEFAULT 0,
  star_velocity_24h INTEGER NOT NULL DEFAULT 0,
  sync_state TEXT NOT NULL DEFAULT 'ok',
  last_synced_at TEXT,
  readme_md TEXT,
  readme_sha TEXT,
  readme_fetched_at TEXT,
  summary_json TEXT NOT NULL DEFAULT '[]',
  summary_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_repos_stars ON repos(stars DESC);
CREATE INDEX IF NOT EXISTS idx_repos_sync ON repos(sync_state);

CREATE TABLE IF NOT EXISTS verification_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet TEXT NOT NULL,
  repo_lc TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verify_challenge_user ON verification_challenges(user_id, expires_at);

CREATE TABLE IF NOT EXISTS repo_verifications (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL UNIQUE REFERENCES repos(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  wallet TEXT NOT NULL,
  readme_sha TEXT,
  verified_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repo_nfts (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL UNIQUE REFERENCES repos(id) ON DELETE CASCADE,
  token_id TEXT,
  owner_wallet TEXT,
  status TEXT NOT NULL DEFAULT 'escrowed',
  metadata_uri TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  oracle_signature TEXT NOT NULL,
  oracle_public_key TEXT NOT NULL,
  minted_at TEXT NOT NULL,
  claimed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL UNIQUE REFERENCES repos(id),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ticker TEXT NOT NULL,
  description TEXT,
  logo_url TEXT NOT NULL,
  logo_ipfs_url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  website TEXT,
  twitter TEXT,
  owner_wallet TEXT,
  creator_wallet TEXT NOT NULL,
  verification TEXT NOT NULL DEFAULT 'community',
  status TEXT NOT NULL DEFAULT 'prelaunch',
  tier TEXT NOT NULL,
  target_market_cap_micro INTEGER NOT NULL,
  launch_mc_usd_micro INTEGER NOT NULL DEFAULT 0,
  launch_stars INTEGER NOT NULL DEFAULT 0,
  total_supply_micro INTEGER NOT NULL,
  curve_supply_micro INTEGER NOT NULL,
  sold_micro INTEGER NOT NULL DEFAULT 0,
  reserve_micro INTEGER NOT NULL DEFAULT 0,
  pool_quote_micro INTEGER NOT NULL DEFAULT 0,
  pool_token_micro INTEGER NOT NULL DEFAULT 0,
  burned_micro INTEGER NOT NULL DEFAULT 0,
  milestone_reserve_micro INTEGER NOT NULL,
  last_price_micro INTEGER NOT NULL DEFAULT 0,
  volume_24h_micro INTEGER NOT NULL DEFAULT 0,
  volume_total_micro INTEGER NOT NULL DEFAULT 0,
  holder_count INTEGER NOT NULL DEFAULT 0,
  unclaimed_dev_vault_micro INTEGER NOT NULL DEFAULT 0,
  royalty_frozen INTEGER NOT NULL DEFAULT 0,
  vip_threshold_micro INTEGER NOT NULL,
  dividend_acc_scaled TEXT NOT NULL DEFAULT '0',
  total_staked_micro INTEGER NOT NULL DEFAULT 0,
  pending_yield_micro INTEGER NOT NULL DEFAULT 0,
  launch_at TEXT,
  launched_at TEXT,
  graduated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status);
CREATE INDEX IF NOT EXISTS idx_tokens_volume ON tokens(volume_24h_micro DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_owner ON tokens(owner_wallet);

CREATE TABLE IF NOT EXISTS holdings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  amount_micro INTEGER NOT NULL DEFAULT 0,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  realized_pnl_micro INTEGER NOT NULL DEFAULT 0,
  vesting_locked_micro INTEGER NOT NULL DEFAULT 0,
  vesting_until TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, token_id)
);
CREATE INDEX IF NOT EXISTS idx_holdings_token ON holdings(token_id, amount_micro DESC);

CREATE TABLE IF NOT EXISTS stakes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  amount_micro INTEGER NOT NULL,
  lock_days INTEGER NOT NULL,
  multiplier_bps INTEGER NOT NULL,
  reward_debt_scaled TEXT NOT NULL DEFAULT '0',
  started_at TEXT NOT NULL,
  unlock_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, token_id)
);
CREATE INDEX IF NOT EXISTS idx_stakes_token ON stakes(token_id);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL REFERENCES tokens(id),
  user_id TEXT REFERENCES users(id),
  wallet TEXT NOT NULL,
  side TEXT NOT NULL,
  phase TEXT NOT NULL,
  token_micro INTEGER NOT NULL,
  usd_micro INTEGER NOT NULL,
  fee_micro INTEGER NOT NULL,
  price_micro INTEGER NOT NULL,
  fee_event_id TEXT,
  tx_hash TEXT NOT NULL UNIQUE,
  idempotency_key TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_token_time ON trades(token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_volume ON trades(created_at DESC);

CREATE TABLE IF NOT EXISTS price_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  time INTEGER NOT NULL,
  price_micro INTEGER NOT NULL,
  volume_micro INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT 'trade',
  label TEXT,
  trade_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_price_token_time ON price_points(token_id, time);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  token_id TEXT REFERENCES tokens(id) ON DELETE CASCADE,
  repo_id TEXT REFERENCES repos(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor_wallet TEXT,
  message TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_time ON activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_token ON activities(token_id, created_at DESC);

CREATE TABLE IF NOT EXISTS earnings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet TEXT NOT NULL,
  token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  amount_micro INTEGER NOT NULL,
  claimed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_earnings_user ON earnings(user_id, claimed_at);
CREATE INDEX IF NOT EXISTS idx_earnings_token ON earnings(token_id, claimed_at);

CREATE TABLE IF NOT EXISTS fee_events (
  id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL UNIQUE REFERENCES trades(id),
  token_id TEXT NOT NULL REFERENCES tokens(id),
  dev_fee_micro INTEGER NOT NULL,
  platform_gross_micro INTEGER NOT NULL,
  dividend_micro INTEGER NOT NULL,
  platform_net_micro INTEGER NOT NULL,
  referral_micro INTEGER NOT NULL,
  dev_to_vault INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fee_token ON fee_events(token_id);

CREATE TABLE IF NOT EXISTS dividend_events (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL REFERENCES tokens(id),
  trade_id TEXT,
  amount_micro INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS star_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  stars INTEGER NOT NULL,
  taken_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_star_snapshots ON star_snapshots(repo_id, taken_at DESC);

CREATE TABLE IF NOT EXISTS star_events (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  stars INTEGER NOT NULL,
  milestone INTEGER NOT NULL,
  burn_micro INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  wallet TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_token ON chat_messages(token_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bounties (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  creator_wallet TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  reward_micro INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  claimant_wallet TEXT,
  submission_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bounties_token ON bounties(token_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bounty_submissions (
  id TEXT PRIMARY KEY,
  bounty_id TEXT NOT NULL REFERENCES bounties(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet TEXT NOT NULL,
  url TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bounty_submissions ON bounty_submissions(bounty_id, created_at DESC);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  creator_wallet TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  closes_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_token ON proposals(token_id, created_at DESC);

CREATE TABLE IF NOT EXISTS proposal_votes (
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet TEXT NOT NULL,
  weight_micro INTEGER NOT NULL,
  choice TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(proposal_id, user_id)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_receipts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  aggregate TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  prev_digest TEXT NOT NULL,
  oracle_public_key TEXT NOT NULL,
  oracle_signature TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_txs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  aggregate TEXT NOT NULL,
  subject_id TEXT,
  network TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  method TEXT NOT NULL,
  args_json TEXT NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  explorer_url TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_chain_txs_aggregate ON chain_txs(kind, aggregate, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chain_txs_subject ON chain_txs(subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chain_txs_status ON chain_txs(status);

CREATE TABLE IF NOT EXISTS platform_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS launch_payments (
  tx_hash TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  amount_yocto TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO platform_config(key, value) VALUES ('paused', 'false');
INSERT OR IGNORE INTO platform_config(key, value) VALUES ('feeds_started', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`;

export function initDb(): void {
  db.exec(schema);
  for (const statement of [
    "ALTER TABLE tokens ADD COLUMN logo_ipfs_url TEXT",
    "ALTER TABLE tokens ADD COLUMN launch_mc_usd_micro INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tokens ADD COLUMN launch_stars INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      db.exec(statement);
    } catch {
      // Column already exists on this database.
    }
  }
}

export function withTransaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw error;
  }
}

export function rowToObject<T = Record<string, unknown>>(row: unknown): T {
  return row as T;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addSecondsIso(seconds: number, from = Date.now()): string {
  return new Date(from + seconds * 1000).toISOString();
}

export function getConfig(key: string): string | null {
  const row = db.prepare("SELECT value FROM platform_config WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setConfig(key: string, value: string): void {
  db.prepare(
    "INSERT INTO platform_config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function isPaused(): boolean {
  return getConfig("paused") === "true";
}

export { config };
