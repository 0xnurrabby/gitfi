import crypto from "node:crypto";
import { config, warn } from "./config.js";
import { addSecondsIso, db, nowIso, withTransaction } from "./db.js";
import { randomId, type UserRow } from "./auth.js";
import { GithubError, fetchReadmeAtLatestCommit, fetchReadmeFromApi, loadGithubRepo, normalizeRepo, readmeContainsCode, upsertRepo } from "./github.js";
import { appendReceipt, oracleKey, signBytes } from "./ledger.js";
import {
  claimDeedAndWait,
  latestChainTx,
  mintDeedAndWait,
  queueReceiptAnchor,
  reassignDeedAndWait,
  type ChainTx,
} from "./chain.js";
import { generateSummary } from "./summarize.js";
import { setOnChainMarketOwner } from "./onchain.js";
import {
  getRepo,
  getTokenById,
  repoSummary,
  tokenSummary,
  type RepoRow,
  type TokenRow,
} from "./tokens.js";
import type { VerifyResult } from "../shared/types.js";
import { TIERS, TOTAL_SUPPLY_MICRO, CURVE_SUPPLY_MICRO, MILESTONE_RESERVE_MICRO } from "../shared/economics.js";
import { VIP_THRESHOLD_BPS as VIP_BPS_SHARED } from "../shared/constants.js";

const VERIFICATION_TTL_SECONDS = 60 * 60 * 24;

function walletIsSandbox(address: string | null | undefined): boolean {
  if (!address) return false;
  const row = db.prepare("SELECT is_sandbox FROM users WHERE address = ?").get(address) as
    | { is_sandbox: number }
    | undefined;
  return Boolean(row?.is_sandbox);
}

function verificationResultForRepo(user: UserRow, repo: RepoRow): VerifyResult {
  const token = db
    .prepare("SELECT * FROM tokens WHERE repo_id = ?")
    .get(repo.id) as TokenRow | undefined;
  const owned = Boolean(token?.owner_wallet && token.owner_wallet === user.address);
  return {
    repo: repoSummary(repo),
    verified: true,
    wallet: user.address,
    readmeUrl: repo.readme_md ? `https://github.com/${repo.full_name}#readme` : "",
    readmeSha: repo.readme_sha ?? "",
    token: token ? tokenSummary(token, repo) : null,
    canLaunch: !token,
    claim: token
      ? {
          available: false,
          tokenId: token.id,
          tokenName: token.name,
          unclaimedMicro: 0,
          alreadyOwnedByYou: owned,
        }
      : null,
    next: token ? "existing" : "launch",
  };
}

/**
 * A previously used challenge is not a failure: if this wallet already proved
 * this exact repository, return the resumable result. This makes retries after
 * a slow GitHub raw propagation safe and idempotent.
 */
function usedChallengeResult(user: UserRow, repoFullName: string): VerifyResult | null {
  const repo = db
    .prepare("SELECT * FROM repos WHERE full_name_lc = ?")
    .get(repoFullName.toLowerCase()) as RepoRow | undefined;
  if (!repo) return null;
  const verification = db
    .prepare("SELECT wallet FROM repo_verifications WHERE repo_id = ?")
    .get(repo.id) as { wallet: string } | undefined;
  if (verification?.wallet !== user.address) return null;
  return verificationResultForRepo(user, repo);
}

export function resumeRepoVerification(user: UserRow, repoInput: string): VerifyResult | null {
  const repoName = normalizeRepo(repoInput);
  return usedChallengeResult(user, repoName);
}

export function createRepoChallenge(user: UserRow, repoInput: string): {
  challengeId: string;
  repo: string;
  code: string;
  line: string;
  expiresAt: string;
} {
  const repo = normalizeRepo(repoInput);
  const existingVerification = db
    .prepare(
      `SELECT rv.wallet, r.full_name FROM repo_verifications rv JOIN repos r ON r.id = rv.repo_id WHERE r.full_name_lc = ?`,
    )
    .get(repo.toLowerCase()) as { wallet: string; full_name: string } | undefined;
  const canMigrateSandboxOwner =
    !user.is_sandbox && Boolean(existingVerification && walletIsSandbox(existingVerification.wallet));
  if (existingVerification && existingVerification.wallet !== user.address && !canMigrateSandboxOwner) {
    throw new GithubError(
      `${existingVerification.full_name} is already cryptographically verified by another wallet.`,
      409,
      "REPO_CLAIMED",
    );
  }
  const code = `GF-${crypto.randomBytes(4).toString("hex").toUpperCase()}-${crypto
    .randomBytes(4)
    .toString("hex")
    .toUpperCase()}`;
  const line = `GitFi.fun sync ID: ${code} · wallet ${user.address} · repo ${repo}`;
  const id = randomId("vch_");
  const expiresAt = addSecondsIso(VERIFICATION_TTL_SECONDS);
  const now = nowIso();
  // Invalidate older open challenges from this wallet for the same repo.
  db.prepare(
    `UPDATE verification_challenges SET used_at = ? WHERE user_id = ? AND repo_lc = ? AND used_at IS NULL`,
  ).run(now, user.id, repo.toLowerCase());
  db.prepare(
    `INSERT INTO verification_challenges(id, user_id, wallet, repo_lc, repo_full_name, nonce, code, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    user.id,
    user.address,
    repo.toLowerCase(),
    repo,
    crypto.randomBytes(16).toString("hex"),
    line,
    expiresAt,
    now,
  );
  return { challengeId: id, repo, code, line, expiresAt };
}

export async function verifyRepoChallenge(
  user: UserRow,
  challengeId: string,
): Promise<VerifyResult> {
  const challenge = db
    .prepare("SELECT * FROM verification_challenges WHERE id = ? AND user_id = ?")
    .get(challengeId, user.id) as
    | {
        id: string;
        user_id: string;
        wallet: string;
        repo_lc: string;
        repo_full_name: string;
        code: string;
        expires_at: string;
        used_at: string | null;
      }
    | undefined;
  if (!challenge) {
    throw new GithubError("Verification challenge not found.", 404, "CHALLENGE_NOT_FOUND");
  }
  if (challenge.wallet !== user.address) {
    throw new GithubError("This verification code belongs to another wallet.", 403, "WALLET_MISMATCH");
  }
  // Already proven by this wallet? Resume without touching GitHub. This makes
  // Retry/Regenerate/Refresh completely free after a successful verification.
  const alreadyVerified = usedChallengeResult(user, challenge.repo_full_name);
  if (alreadyVerified) {
    if (!challenge.used_at) {
      db.prepare("UPDATE verification_challenges SET used_at = ? WHERE id = ?").run(
        nowIso(),
        challenge.id,
      );
    }
    return alreadyVerified;
  }
  if (challenge.used_at) {
    throw new GithubError("This verification code has already been used.", 409, "CHALLENGE_USED");
  }
  if (challenge.expires_at < nowIso()) {
    throw new GithubError("This verification code expired. Generate a fresh one.", 410, "CHALLENGE_EXPIRED");
  }

  const data = await loadGithubRepo(challenge.repo_full_name, {
    requireReadme: true,
    forceFresh: true,
  });
  const shortCode = challenge.code.match(/GF-[A-F0-9]{8}-[A-F0-9]{8}/)?.[0] ?? challenge.code;
  let proofFound =
    Boolean(data.readme && (readmeContainsCode(data.readme, challenge.code) || data.readme.includes(shortCode)));

  if (!proofFound) {
    // raw.githubusercontent.com is the fastest path but can lag a few seconds
    // behind a fresh commit. Fall back to the GitHub contents API so the
    // verification does not fail just because a CDN edge is stale.
    const apiReadme = await fetchReadmeFromApi(data.fullName, data.defaultBranch);
    if (apiReadme) {
      data.readme = apiReadme.markdown;
      data.readmeSha = apiReadme.sha;
      data.readmeUrl = apiReadme.url;
      proofFound =
        readmeContainsCode(apiReadme.markdown, challenge.code) || apiReadme.markdown.includes(shortCode);
    }
  }
  if (!proofFound) {
    // Final quota-free fallback: read the README at the latest commit SHA from
    // the public Atom feed. This is cache-busted per commit and does not consume
    // GitHub's REST quota.
    const latestReadme = await fetchReadmeAtLatestCommit(data.fullName, data.defaultBranch);
    if (latestReadme) {
      data.readme = latestReadme.markdown;
      data.readmeSha = latestReadme.sha;
      data.readmeUrl = latestReadme.url;
      proofFound =
        readmeContainsCode(latestReadme.markdown, challenge.code) ||
        latestReadme.markdown.includes(shortCode);
    }
  }

  if (!proofFound) {
    throw new GithubError(
      "I couldn't find the sync line in the default-branch README yet. Check that the line was committed to that branch, wait 10–20 seconds, then press verify again. Your code remains valid.",
      422,
      "CODE_NOT_FOUND",
    );
  }

  const { repoId } = upsertRepo(data);
  const repo = getRepo(repoId);
  if (!repo) throw new GithubError("Repository could not be indexed.", 500, "REPO_INDEX_FAILED");

  // Refresh the AI read so the token page is useful immediately.
  const summary = await generateSummary(repo.full_name, repo.description, data.readme, safeTopics(repo));
  db.prepare("UPDATE repos SET summary_json = ?, summary_at = ?, readme_md = ?, readme_sha = ?, readme_fetched_at = ? WHERE id = ?").run(
    JSON.stringify(summary),
    nowIso(),
    data.readme,
    data.readmeSha,
    nowIso(),
    repo.id,
  );

  const existingVerification = db
    .prepare("SELECT * FROM repo_verifications WHERE repo_id = ?")
    .get(repo.id) as { wallet: string } | undefined;
  const token = db
    .prepare("SELECT * FROM tokens WHERE repo_id = ?")
    .get(repo.id) as TokenRow | undefined;
  const canMigrateSandboxOwner = Boolean(
    token?.owner_wallet && walletIsSandbox(token.owner_wallet) && !user.is_sandbox,
  );
  if (
    existingVerification &&
    existingVerification.wallet !== user.address &&
    !canMigrateSandboxOwner
  ) {
    throw new GithubError("This repository has already been claimed by another wallet.", 409, "REPO_CLAIMED");
  }
  if (token && token.owner_wallet && token.owner_wallet !== user.address && !canMigrateSandboxOwner) {
    throw new GithubError("This token already has a verified developer.", 409, "TOKEN_CLAIMED");
  }
  if (existingVerification && existingVerification.wallet === user.address && token?.owner_wallet === user.address) {
    db.prepare("UPDATE verification_challenges SET used_at = ? WHERE id = ?").run(nowIso(), challenge.id);
    return {
      repo: repoSummary(getRepo(repo.id)!),
      verified: true,
      wallet: user.address,
      readmeUrl: data.readmeUrl ?? "",
      readmeSha: data.readmeSha ?? "",
      token: token ? tokenSummary(token, repo) : null,
      canLaunch: false,
      claim: {
        available: false,
        tokenId: token?.id ?? null,
        tokenName: token?.name ?? null,
        unclaimedMicro: 0,
        alreadyOwnedByYou: true,
      },
      next: "existing",
    };
  }

  let claimReceiptDigest: string | null = null;
  const result = withTransaction(() => {
    const now = nowIso();
    db.prepare(
      `INSERT INTO repo_verifications(id, repo_id, user_id, wallet, readme_sha, verified_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo_id) DO NOTHING`,
    ).run(randomId("rvf_"), repo.id, user.id, user.address, data.readmeSha, now);
    db.prepare("UPDATE verification_challenges SET used_at = ? WHERE id = ?").run(now, challenge.id);
    let claimed = false;
    let claimedAmount = 0;
    let migrated = false;
    let nft: Record<string, unknown> | null = null;
    if (token && (!token.owner_wallet || canMigrateSandboxOwner)) {
      claimed = true;
      migrated = canMigrateSandboxOwner;
      const previousOwner = token.owner_wallet;
      const vault = token.unclaimed_dev_vault_micro;
      claimedAmount = vault;
      if (vault > 0) {
        db.prepare(
          `INSERT INTO earnings(id, user_id, wallet, token_id, source, amount_micro, created_at)
           VALUES (?, ?, ?, ?, 'developer', ?, ?)`,
        ).run(randomId("ern_"), user.id, user.address, token.id, vault, now);
      }
      db.prepare(
        "UPDATE tokens SET owner_wallet = ?, verification = 'verified', unclaimed_dev_vault_micro = 0, royalty_frozen = 0, updated_at = ? WHERE id = ?",
      ).run(user.address, now, token.id);
      db.prepare(
        "UPDATE repo_verifications SET user_id = ?, wallet = ?, readme_sha = ?, verified_at = ? WHERE repo_id = ?",
      ).run(user.id, user.address, data.readmeSha, now, repo.id);
      db.prepare(
        "UPDATE repo_nfts SET owner_wallet = ?, status = 'staked', claimed_at = ?, updated_at = ? WHERE repo_id = ?",
      ).run(user.address, now, now, repo.id);
      const nftRow = db
        .prepare("SELECT * FROM repo_nfts WHERE repo_id = ?")
        .get(repo.id) as { id: string; metadata_json: string } | undefined;
      if (nftRow?.metadata_json) {
        try {
          const metadata = JSON.parse(nftRow.metadata_json) as Record<string, unknown>;
          metadata.owner = user.address;
          db.prepare("UPDATE repo_nfts SET metadata_json = ? WHERE repo_id = ?").run(
            JSON.stringify(metadata),
            repo.id,
          );
        } catch {
          // Preserve metadata if it cannot be parsed.
        }
      }
      nft = (nftRow as unknown as Record<string, unknown>) ?? null;
      db.prepare(
        `INSERT INTO activities(id, token_id, type, actor_wallet, message, metadata_json, created_at)
         VALUES (?, ?, 'claim', ?, ?, ?, ?)`,
      ).run(
        randomId("act_"),
        token.id,
        user.address,
        migrated
          ? `migrated $${token.ticker} ownership to ${user.address}`
          : `claimed $${token.ticker} and unlocked $${(vault / 1_000_000).toFixed(2)} in developer royalties`,
        JSON.stringify({ vaultMicro: vault, migrated, previousOwner }),
        now,
      );
      const claimReceipt = appendReceipt("ownership.claim", token.id, {
        tokenId: token.id,
        repo: repo.full_name,
        wallet: user.address,
        previousOwner,
        migrated,
        vaultMicro: vault,
      });
      claimReceiptDigest = claimReceipt.digest;
    }
    db.prepare(
      `INSERT INTO activities(id, repo_id, type, actor_wallet, message, metadata_json, created_at)
       VALUES (?, ?, 'verify', ?, ?, ?, ?)`,
    ).run(
      randomId("act_"),
      repo.id,
      user.address,
      `cryptographically verified ${repo.full_name}`,
      JSON.stringify({ repo: repo.full_name }),
      now,
    );
    return { claimed, claimedAmount, nft, migrated };
  });

  const freshRepo = getRepo(repo.id)!;
  const freshToken = getTokenById(token?.id ?? "") ?? null;
  if (freshToken) {
    appendReceipt("repo.verify", repo.id, {
      repo: repo.full_name,
      wallet: user.address,
      tokenId: freshToken.id,
      claimed: result.claimed,
    });
  }
  let chain: ChainTx | null = null;
  if (freshToken && claimReceiptDigest) {
    queueReceiptAnchor({
      kind: "ownership.claim",
      aggregate: freshToken.id,
      digest: claimReceiptDigest,
      subjectId: freshToken.id,
    });
    const deedMint = latestChainTx("deed.mint", freshRepo.full_name.toLowerCase());
    const deedInput = {
      repo: freshRepo.full_name,
      tokenId: freshToken.id,
      owner: user.address,
      metadataUri: `${config.appUrl.replace(/\/$/, "")}${metadataUrl(freshToken.id)}`,
      subjectId: freshToken.id,
    };
    try {
      if (result.migrated) {
        chain = await reassignDeedAndWait(
          {
            repo: freshRepo.full_name,
            tokenId: freshToken.id,
            newOwner: user.address,
            metadataUri: deedInput.metadataUri,
            subjectId: freshToken.id,
          },
          15_000,
        );
      } else {
        chain =
          deedMint?.status === "confirmed"
            ? await claimDeedAndWait(
                {
                  repo: freshRepo.full_name,
                  tokenId: freshToken.id,
                  newOwner: user.address,
                  metadataUri: deedInput.metadataUri,
                  subjectId: freshToken.id,
                },
                15_000,
              )
            : await mintDeedAndWait(deedInput, 15_000);
      }
    } catch (error) {
      warn(`NEAR deed ownership update failed for ${freshRepo.full_name}: ${(error as Error).message}`);
    }
  }
  if (result.claimed && freshToken && !user.is_sandbox) {
    try {
      await setOnChainMarketOwner(freshToken.id, user.address);
    } catch (error) {
      warn(`market owner update failed for ${freshToken.id}: ${(error as Error).message}`);
    }
  }
  return {
    repo: repoSummary(freshRepo),
    verified: true,
    wallet: user.address,
    readmeUrl: data.readmeUrl ?? "",
    readmeSha: data.readmeSha ?? "",
    token: freshToken ? tokenSummary(freshToken, freshRepo) : null,
    canLaunch: !freshToken,
    claim: freshToken
      ? {
          available: result.claimed,
          tokenId: freshToken.id,
          tokenName: freshToken.name,
          unclaimedMicro: result.claimedAmount,
          alreadyOwnedByYou: freshToken.owner_wallet === user.address,
        }
      : null,
    next: result.claimed ? "claim" : freshToken ? "existing" : "launch",
    chain,
  };
}

export function safeTopics(repo: RepoRow): string[] {
  try {
    const parsed = JSON.parse(repo.topics_json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function requireVerification(user: UserRow, repoId: string): void {
  const verification = db
    .prepare("SELECT 1 FROM repo_verifications WHERE repo_id = ? AND wallet = ?")
    .get(repoId, user.address);
  if (!verification) {
    throw new GithubError(
      "Verify ownership of this repository with a README sync code before launching it as the developer.",
      403,
      "OWNER_VERIFICATION_REQUIRED",
    );
  }
}

export function isRepoVerifiedByAnyone(repoId: string): { wallet: string } | null {
  return (
    (db
      .prepare("SELECT wallet FROM repo_verifications WHERE repo_id = ?")
      .get(repoId) as { wallet: string } | undefined) ?? null
  );
}

export function vipThresholdMicro(): number {
  return Math.floor((TOTAL_SUPPLY_MICRO * VIP_BPS_SHARED) / 10_000);
}

export function tokenConfigForTier(tier: keyof typeof TIERS): {
  targetMarketCapMicro: number;
  countdownSeconds: number;
  vipThresholdMicro: number;
} {
  return {
    targetMarketCapMicro: TIERS[tier].targetMarketCapMicro,
    countdownSeconds: TIERS[tier].countdownSeconds,
    vipThresholdMicro: vipThresholdMicro(),
  };
}

export function nftDeedSignature(payload: Record<string, unknown>): string {
  return signBytes(JSON.stringify(payload));
}

export function metadataUrl(tokenId: string): string {
  return `${config.appUrl.replace(/\/$/, "")}/api/nft/${tokenId}/metadata`;
}

export function buildNftMetadata(input: {
  tokenId: string;
  repoFullName: string;
  repoDescription: string | null;
  tokenName: string;
  ticker: string;
  logoUrl: string;
  owner: string | null;
  stars: number;
  tier: string;
}): Record<string, unknown> {
  const base = config.appUrl.replace(/\/$/, "");
  const image = input.logoUrl.startsWith("data:")
    ? input.logoUrl
    : `${base}${input.logoUrl}`;
  return {
    title: `GitFi Repo Deed · ${input.repoFullName}`,
    description: `The unique protocol deed and license for the ${input.repoFullName} repository token ($ ${input.ticker}). Staked to the GitFi vault.`,
    media: image,
    image,
    reference: `${base}/token/${input.tokenId}`,
    copies: 1,
    repo: input.repoFullName,
    tokenId: input.tokenId,
    owner: input.owner,
    attributes: {
      repo: input.repoFullName,
      tier: input.tier,
      github_stars: input.stars,
      ticker: input.ticker,
      utility_token: input.tokenName,
    },
  };
}

export function ensureCurveConstants(): void {
  if (CURVE_SUPPLY_MICRO + MILESTONE_RESERVE_MICRO !== TOTAL_SUPPLY_MICRO) {
    throw new Error("Economic constants are inconsistent.");
  }
  void oracleKey;
}
