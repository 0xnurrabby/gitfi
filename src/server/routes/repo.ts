import { Router } from "express";
import { z } from "zod";
import { optionalAuth, requireAuth } from "../auth.js";
import { asyncHandler, ApiError } from "../http.js";
import { createRepoChallenge, resumeRepoVerification, verifyRepoChallenge } from "../repos.js";
import { launchToken, updateTokenLogo } from "../token-service.js";
import { loadGithubRepo, normalizeRepo, GithubError } from "../github.js";
import { generateSummary } from "../summarize.js";
import { db } from "../db.js";
import { githubLimiter, writeLimiter } from "../security.js";
import { publish } from "../realtime.js";
import { tokenDetailById } from "../readers.js";
import { getKing, invalidateKing } from "../king.js";
import { getTokenById } from "../tokens.js";

export const repoRouter = Router();

const repoChallengeSchema = z.object({
  repo: z.string().min(3).max(200),
});

repoRouter.post(
  "/repos/verify/challenge",
  writeLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = repoChallengeSchema.parse(req.body);
    const challenge = createRepoChallenge(req.user!, input.repo);
    res.json(challenge);
  }),
);

repoRouter.post(
  "/repos/verify/resume",
  writeLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = z.object({ repo: z.string().min(3).max(200) }).parse(req.body);
    const result = resumeRepoVerification(req.user!, input.repo);
    res.json({ verified: Boolean(result), result });
  }),
);

repoRouter.post(
  "/repos/verify",
  githubLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = z.object({ challengeId: z.string().min(4).max(80) }).parse(req.body);
    const result = await verifyRepoChallenge(req.user!, input.challengeId);
    if (result.token) {
      const fresh = tokenDetailById(result.token.id, req.user!);
      if (fresh) {
        publish({ type: "token", tokenId: fresh.id, data: { tokenId: fresh.id, kind: "verified" } });
      }
      invalidateKing();
      publish({ type: "king", data: getKing() });
    }
    res.json(result);
  }),
);

repoRouter.get(
  "/github/repo",
  githubLimiter,
  asyncHandler(async (req, res) => {
    const repoInput = z.string().min(3).max(200).parse(req.query.repo);
    const fullName = normalizeRepo(repoInput);
    const existing = db
      .prepare(
        `SELECT t.id, t.slug, t.name, t.ticker, t.owner_wallet FROM tokens t
         JOIN repos r ON r.id = t.repo_id WHERE r.full_name_lc = ?`,
      )
      .get(fullName.toLowerCase()) as
      | { id: string; slug: string; name: string; ticker: string; owner_wallet: string | null }
      | undefined;
    const data = await loadGithubRepo(fullName, { skipReadme: false });
    const summary = await generateSummary(fullName, data.description, data.readme, data.topics);
    res.json({
      repo: {
        fullName: data.fullName,
        description: data.description,
        stars: data.stars,
        forks: data.forks,
        language: data.language,
        topics: data.topics,
        license: data.license,
        healthScore: data.healthScore,
        commitCount: data.commitCount,
        pushedAt: data.pushedAt,
        createdAtGithub: data.createdAt,
        defaultBranch: data.defaultBranch,
        readmePresent: Boolean(data.readme),
      },
      summary,
      existingToken: existing ?? null,
      indexed: Boolean(existing),
    });
  }),
);

const launchSchema = z.object({
  repo: z.string().min(3).max(200),
  mode: z.literal("owner"),
  name: z.string().trim().min(2).max(48),
  ticker: z.string().trim().toUpperCase().min(2).max(10),
  description: z.string().trim().min(24).max(600),
  website: z.string().trim().max(300).optional(),
  twitter: z.string().trim().max(300).optional(),
  logoDataUrl: z.string().max(9_000_000).optional(),
  verificationChallengeId: z.string().max(80).optional(),
  paymentTxHash: z.string().min(20).max(100),
});

repoRouter.post(
  "/tokens",
  writeLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = launchSchema.parse(req.body);
    const result = await launchToken(req.user!, input);
    invalidateKing();
    publish({
      type: "activity",
      data: {
        type: "launch",
        tokenId: result.token.id,
        ticker: result.token.ticker,
        slug: result.token.slug,
        logoUrl: result.token.logoUrl,
        message: `launched $${result.token.ticker} for ${result.token.repo.fullName}`,
      },
    });
    res.status(201).json(result);
  }),
);

repoRouter.post(
  "/tokens/:id/logo",
  writeLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = z.object({ dataUrl: z.string().min(30).max(9_000_000) }).parse(req.body);
    const token = getTokenById(String(req.params.id));
    if (!token) throw new ApiError("Token not found.", 404, "TOKEN_NOT_FOUND");
    const summary = await updateTokenLogo(req.user!, token.id, body.dataUrl);
    publish({ type: "token", tokenId: token.id, data: { tokenId: token.id, logoUrl: summary.logoUrl } });
    res.json({ token: summary });
  }),
);

repoRouter.get(
  "/repos/verify/status",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const repo = normalizeRepo(z.string().parse(req.query.repo));
    const row = db
      .prepare(
        `SELECT r.id, r.full_name, rv.wallet, t.id AS token_id, t.slug, t.ticker, t.owner_wallet
         FROM repos r LEFT JOIN repo_verifications rv ON rv.repo_id = r.id
         LEFT JOIN tokens t ON t.repo_id = r.id WHERE r.full_name_lc = ?`,
      )
      .get(repo.toLowerCase()) as
      | {
          id: string;
          full_name: string;
          wallet: string | null;
          token_id: string | null;
          slug: string | null;
          ticker: string | null;
          owner_wallet: string | null;
        }
      | undefined;
    if (!row) {
      res.json({ indexed: false, verified: false, token: null });
      return;
    }
    res.json({
      indexed: true,
      repo: row.full_name,
      verified: Boolean(row.wallet),
      verifiedByYou: req.user?.address === row.wallet,
      token: row.token_id
        ? {
            id: row.token_id,
            slug: row.slug,
            ticker: row.ticker,
            owner: row.owner_wallet,
            claimable: !row.owner_wallet,
          }
        : null,
    });
  }),
);
