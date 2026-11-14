import crypto from "node:crypto";
import { db, nowIso, withTransaction } from "./db.js";
import { randomId, type UserRow } from "./auth.js";
import { GithubError, loadGithubRepo, normalizeRepo, upsertRepo } from "./github.js";
import { generateLogo, saveLogoDataUrl } from "./logo.js";
import { generateSummary } from "./summarize.js";
import { appendReceipt, oracleKey, sha256Hex, signBytes } from "./ledger.js";
import { mintDeedAndWait, queueReceiptAnchor, type ChainTx } from "./chain.js";
import { createOnChainMarket } from "./onchain.js";
import { recordLaunchPayment, verifyLaunchPayment } from "./launch-payment.js";
import {
  buildNftMetadata,
  metadataUrl,
  requireVerification,
  safeTopics,
  tokenConfigForTier,
} from "./repos.js";
import {
  getRepo,
  getTokenRow,
  repoSummary,
  tokenSummary,
  type RepoRow,
  type TokenRow,
} from "./tokens.js";
import type { LaunchInput, TokenSummary } from "../shared/types.js";
import {
  CURVE_SUPPLY_MICRO,
  MILESTONE_RESERVE_MICRO,
  TIERS,
  TOTAL_SUPPLY_MICRO,
  curveLaunchPriceMicro,
  tierForStars,
} from "../shared/economics.js";
import { TICKER_REGEX } from "../shared/constants.js";
import { config, warn } from "./config.js";

export interface LaunchResult {
  token: TokenSummary;
  receipt: string;
  nftId: string;
  chain: ChainTx | null;
}

function cleanSocial(value: string | undefined, label: string): string | null {
  if (!value || !value.trim()) return null;
  let candidate = value.trim();
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    if (url.hostname.length > 253) throw new Error();
    return url.toString();
  } catch {
    throw new GithubError(`${label} must be a valid URL.`, 400, "INVALID_LINK");
  }
}

export async function launchToken(user: UserRow, input: LaunchInput): Promise<LaunchResult> {
  if (input.mode !== "owner") {
    throw new GithubError(
      "Only the verified repository owner can create a token. Prove ownership with the README sync line first.",
      403,
      "OWNER_ONLY",
    );
  }
  const payment = await verifyLaunchPayment(input.paymentTxHash, user.address);
  const fullName = normalizeRepo(input.repo);
  if (!TICKER_REGEX.test(input.ticker)) {
    throw new GithubError("Ticker must be 2–10 uppercase letters or numbers.", 400, "INVALID_TICKER");
  }
  if (input.name.trim().length < 2 || input.name.trim().length > 48) {
    throw new GithubError("Token name must be 2–48 characters.", 400, "INVALID_NAME");
  }
  if (input.description.trim().length < 24 || input.description.trim().length > 600) {
    throw new GithubError("Description must be 24–600 characters.", 400, "INVALID_DESCRIPTION");
  }
  const existingRepo = db
    .prepare("SELECT * FROM repos WHERE full_name_lc = ?")
    .get(fullName.toLowerCase()) as RepoRow | undefined;
  if (existingRepo) {
    const existingToken = db
      .prepare("SELECT id FROM tokens WHERE repo_id = ?")
      .get(existingRepo.id) as { id: string } | undefined;
    if (existingToken) {
      throw new GithubError("This repository already has a token.", 409, "TOKEN_EXISTS");
    }
    requireVerification(user, existingRepo.id);
  }
  const tickerConflict = db
    .prepare("SELECT id FROM tokens WHERE upper(ticker) = ?")
    .get(input.ticker.toUpperCase()) as { id: string } | undefined;
  if (tickerConflict) {
    throw new GithubError(`$${input.ticker} is already taken by another repository.`, 409, "TICKER_TAKEN");
  }

  const github = await loadGithubRepo(fullName, { requireReadme: true });
  if (!github.readme) {
    throw new GithubError("The repository needs a public README.md.", 422, "README_MISSING");
  }
  const { repoId } = upsertRepo(github);
  const repo = getRepo(repoId);
  if (!repo) throw new GithubError("Could not index repository.", 500, "REPO_INDEX_FAILED");
  requireVerification(user, repo.id);
  const postUpsertToken = db
    .prepare("SELECT id FROM tokens WHERE repo_id = ?")
    .get(repo.id) as { id: string } | undefined;
  if (postUpsertToken) {
    throw new GithubError("This repository already has a token.", 409, "TOKEN_EXISTS");
  }

  const tier = tierForStars(github.stars);
  const tierConfig = TIERS[tier];
  const summary = await generateSummary(repo.full_name, repo.description, github.readme, safeTopics(repo));
  db.prepare("UPDATE repos SET summary_json = ?, summary_at = ? WHERE id = ?").run(
    JSON.stringify(summary),
    nowIso(),
    repo.id,
  );

  let logo;
  if (input.logoDataUrl) {
    try {
      logo = await saveLogoDataUrl(input.logoDataUrl);
    } catch (error) {
      throw new GithubError((error as Error).message, 400, "INVALID_LOGO");
    }
  } else {
    logo = await generateLogo(input.ticker, repo.full_name);
  }

  const tokenId = `tok_${crypto.randomBytes(10).toString("hex")}`;
  const slugBase = `${input.ticker.toLowerCase()}-${repo.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  let slug = slugBase.slice(0, 72);
  let suffix = 2;
  while (db.prepare("SELECT 1 FROM tokens WHERE slug = ?").get(slug)) {
    slug = `${slugBase.slice(0, 66)}-${suffix++}`;
  }
  const website = cleanSocial(input.website, "Website");
  const twitter = cleanSocial(input.twitter, "Social link");
  const now = nowIso();
  const countdown = tierConfig.countdownSeconds;
  const launchAt = countdown > 0 ? new Date(Date.now() + countdown * 1000).toISOString() : now;
  const status = countdown > 0 ? "prelaunch" : "bonding";
  const price = Number(curveLaunchPriceMicro(tier));
  const vip = tokenConfigForTier(tier).vipThresholdMicro;
  const appBase = config.appUrl.replace(/\/$/, "");
  const logoSrc = logo.logoUrl.startsWith("data:") ? logo.logoUrl : `${appBase}${logo.logoUrl}`;
  const metadata = {
    spec: "ft-1.0.0",
    schema: "gitfi-token/1.0",
    name: input.name.trim(),
    symbol: input.ticker,
    ticker: input.ticker,
    description: input.description.trim(),
    icon: logoSrc,
    image: logoSrc,
    reference: `${appBase}/token/${slug}`,
    repo: repo.full_name,
    website,
    twitter,
    tier,
    total_supply: "1000000000",
    decimals: 6,
    creator: user.address,
    owner: user.address,
    verified_repository: true,
  };
  const nftId = `nft_${crypto.randomBytes(10).toString("hex")}`;
  const verificationProof = db
    .prepare(
      "SELECT wallet, readme_sha, verified_at FROM repo_verifications WHERE repo_id = ? AND wallet = ?",
    )
    .get(repo.id, user.address) as
    | { wallet: string; readme_sha: string | null; verified_at: string }
    | undefined;
  const deedPayload = {
    standard: "gitfi-repo-deed/1.0",
    repo: repo.full_name,
    githubId: github.githubId,
    tokenId,
    owner: user.address,
    verification: verificationProof
      ? {
          wallet: verificationProof.wallet,
          readmeSha: verificationProof.readme_sha,
          verifiedAt: verificationProof.verified_at,
        }
      : null,
    metadataUri: metadataUrl(tokenId),
    nonce: crypto.randomBytes(16).toString("hex"),
    issuedAt: now,
  };
  const signature = signBytes(JSON.stringify(deedPayload));
  const txHash = sha256Hex(JSON.stringify(deedPayload));
  const nftMetadata = buildNftMetadata({
    tokenId,
    repoFullName: repo.full_name,
    repoDescription: repo.description,
    tokenName: input.name.trim(),
    ticker: input.ticker,
    logoUrl: logo.logoUrl,
    owner: user.address,
    stars: repo.stars,
    tier,
  });

  // The market is the real token ledger. Create it on-chain first so a launch
  // can never succeed with a fake/local-only asset.
  await createOnChainMarket({
    tokenId,
    repo: repo.full_name,
    ticker: input.ticker,
    owner: user.address,
    totalSupplyMicro: TOTAL_SUPPLY_MICRO,
    curveSupplyMicro: CURVE_SUPPLY_MICRO,
    priceMicro: price,
  });

  const result = withTransaction(() => {
    recordLaunchPayment(payment, user.address);
    db.prepare(
      `INSERT INTO tokens(
        id, repo_id, slug, name, ticker, description, logo_url, metadata_json, website, twitter,
        owner_wallet, creator_wallet, verification, status, tier, target_market_cap_micro,
        total_supply_micro, curve_supply_micro, milestone_reserve_micro, last_price_micro,
        vip_threshold_micro, launch_at, launched_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tokenId,
      repo.id,
      slug,
      input.name.trim(),
      input.ticker,
      input.description.trim(),
      logo.logoUrl,
      JSON.stringify(metadata),
      website,
      twitter,
      user.address,
      user.address,
      "verified",
      status,
      tier,
      tierConfig.targetMarketCapMicro,
      TOTAL_SUPPLY_MICRO,
      CURVE_SUPPLY_MICRO,
      MILESTONE_RESERVE_MICRO,
      price,
      vip,
      launchAt,
      countdown === 0 ? now : null,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO repo_nfts(
        id, repo_id, token_id, owner_wallet, status, metadata_uri, metadata_json, tx_hash,
        oracle_signature, oracle_public_key, minted_at, claimed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nftId,
      repo.id,
      tokenId,
      user.address,
      "staked",
      metadataUrl(tokenId),
      JSON.stringify(nftMetadata),
      txHash,
      signature,
      oracleKey().publicKeyHex,
      now,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO price_points(token_id, time, price_micro, volume_micro, type, label)
       VALUES (?, ?, ?, 0, 'launch', 'Curve launch')`,
    ).run(tokenId, Date.now(), price);
    db.prepare(
      `INSERT INTO activities(id, token_id, type, actor_wallet, message, metadata_json, created_at)
       VALUES (?, ?, 'launch', ?, ?, ?, ?)`,
    ).run(
      randomId("act_"),
      tokenId,
      user.address,
      `launched $${input.ticker} for ${repo.full_name}`,
      JSON.stringify({ mode: "owner", tier }),
      now,
    );
    const mintReceipt = appendReceipt("repo.nft.mint", repo.id, {
      nftId,
      repo: repo.full_name,
      tokenId,
      owner: user.address,
      status: "staked",
      metadataUri: metadataUrl(tokenId),
      deedSignature: signature,
      txHash,
    });
    const tokenReceipt = appendReceipt("token.mint", tokenId, {
      tokenId,
      repo: repo.full_name,
      ticker: input.ticker,
      tier,
      supplyMicro: TOTAL_SUPPLY_MICRO,
      curveSupplyMicro: CURVE_SUPPLY_MICRO,
      targetMarketCapMicro: tierConfig.targetMarketCapMicro,
      owner: user.address,
    });
    if (countdown > 0) {
      appendReceipt("token.prelaunch", tokenId, {
        tokenId,
        launchAt,
        tier,
        countdownSeconds: countdown,
      });
    }
    db.prepare("UPDATE users SET xp = xp + ? WHERE id = ?").run(500, user.id);
    return { nftId, receipt: tokenReceipt.digest, mintReceipt: mintReceipt.digest };
  });

  const fresh = getTokenRow(tokenId)!;
  const freshRepo = getRepo(repo.id)!;
  let chainMint: ChainTx | null = null;
  try {
    chainMint = await mintDeedAndWait(
      {
        repo: repo.full_name,
        tokenId,
        owner: user.address,
        metadataUri: `${config.appUrl.replace(/\/$/, "")}${metadataUrl(tokenId)}`,
        subjectId: tokenId,
      },
      15_000,
    );
  } catch (error) {
    warn(`NEAR deed mint failed for ${repo.full_name}: ${(error as Error).message}`);
  }
  queueReceiptAnchor({
    kind: "token.mint",
    aggregate: tokenId,
    digest: result.receipt,
    subjectId: tokenId,
  });
  return {
    token: tokenSummary(fresh, freshRepo),
    receipt: result.receipt,
    nftId: result.nftId,
    chain: chainMint,
  };
}

export async function updateTokenLogo(
  user: UserRow,
  tokenId: string,
  logoDataUrl: string,
): Promise<TokenSummary> {
  const token = getTokenRow(tokenId);
  if (!token) throw new GithubError("Token not found.", 404, "TOKEN_NOT_FOUND");
  if (!token.owner_wallet || token.owner_wallet !== user.address) {
    throw new GithubError("Only the verified repository owner can update the logo.", 403, "OWNER_ONLY");
  }
  const logo = await saveLogoDataUrl(logoDataUrl);
  const now = nowIso();
  withTransaction(() => {
    const meta = (() => {
      try {
        return JSON.parse(token.metadata_json) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    const appBase = config.appUrl.replace(/\/$/, "");
    const logoSrc = logo.logoUrl.startsWith("data:") ? logo.logoUrl : `${appBase}${logo.logoUrl}`;
    meta.image = logoSrc;
    meta.icon = logoSrc;
    db.prepare(
      "UPDATE tokens SET logo_url = ?, metadata_json = ?, updated_at = ? WHERE id = ?",
    ).run(logo.logoUrl, JSON.stringify(meta), now, token.id);
    const nft = db
      .prepare("SELECT metadata_json FROM repo_nfts WHERE repo_id = ?")
      .get(token.repo_id) as { metadata_json: string } | undefined;
    if (nft) {
      try {
        const nftMeta = JSON.parse(nft.metadata_json) as Record<string, unknown>;
        nftMeta.image = logoSrc;
        nftMeta.media = logoSrc;
        db.prepare("UPDATE repo_nfts SET metadata_json = ?, updated_at = ? WHERE repo_id = ?").run(
          JSON.stringify(nftMeta),
          now,
          token.repo_id,
        );
      } catch {
        // Leave old metadata if corrupt.
      }
    }
    appendReceipt("token.logo.update", token.id, {
      tokenId: token.id,
      wallet: user.address,
      logoUrl: logo.logoUrl,
    });
    db.prepare(
      `INSERT INTO activities(id, token_id, type, actor_wallet, message, metadata_json, created_at)
       VALUES (?, ?, 'verify', ?, ?, ?, ?)`,
    ).run(
      randomId("act_"),
      token.id,
      user.address,
      `updated the on-chain logo for $${token.ticker}`,
      "{}",
      now,
    );
  });
  return tokenSummary(getTokenRow(token.id)!, getRepo(token.repo_id)!);
}

export function tokenMetadata(tokenId: string): Record<string, unknown> | null {
  const token = getTokenRow(tokenId);
  if (!token) return null;
  const repo = getRepo(token.repo_id);
  if (!repo) return null;
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(token.metadata_json) as Record<string, unknown>;
  } catch {
    stored = {};
  }
  return {
    ...stored,
    spec: "ft-1.0.0",
    schema: "gitfi-token/1.0",
    name: token.name,
    symbol: token.ticker,
    ticker: token.ticker,
    description: token.description,
    icon: `${config.appUrl.replace(/\/$/, "")}${token.logo_url}`,
    image: `${config.appUrl.replace(/\/$/, "")}${token.logo_url}`,
    reference: `${config.appUrl.replace(/\/$/, "")}/token/${token.slug}`,
    external_url: `${config.appUrl.replace(/\/$/, "")}/token/${token.slug}`,
    repo: repo.full_name,
    github: `https://github.com/${repo.full_name}`,
    tier: token.tier,
    status: token.status,
    owner: token.owner_wallet,
    decimals: 6,
    supply: "1000000000",
    properties: {
      verified_repository: token.verification === "verified",
      royalty_frozen: Boolean(token.royalty_frozen),
      stars: repo.stars,
    },
  };
}

export function nftMetadata(tokenId: string): Record<string, unknown> | null {
  const token = getTokenRow(tokenId);
  if (!token) return null;
  const row = db
    .prepare("SELECT * FROM repo_nfts WHERE token_id = ?")
    .get(token.id) as { metadata_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.metadata_json) as Record<string, unknown>;
  } catch {
    return null;
  }
}
