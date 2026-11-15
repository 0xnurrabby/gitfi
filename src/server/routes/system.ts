import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, optionalAuth } from "../auth.js";
import { config } from "../config.js";
import { db, isPaused, nowIso, setConfig } from "../db.js";
import { asyncHandler, ApiError } from "../http.js";
import { exploreData, getUserProfile, homeData, leaderboard, portfolioData, searchData } from "../readers.js";
import { exploreOnChain, homeOnChain, leaderboardOnChain, portfolioOnChain, searchOnChain } from "../onchain-index.js";
import { getNearUsd } from "../near-price.js";
import { claimEarnings, refreshVolume24h } from "../engine.js";
import { getKing } from "../king.js";
import { appendReceipt, oracleKey, verifyChain } from "../ledger.js";
import { nftMetadata } from "../token-service.js";
import { getTokenById } from "../tokens.js";
import { getSessionUser, type UserRow } from "../auth.js";
import { publish } from "../realtime.js";
import { syncDueRepos } from "../star.js";
import { claimLimiter, writeLimiter } from "../security.js";
import { chainStatus, latestChainTxsForSubject, recentChainTxs } from "../chain.js";
import { getOnChainMarket, getAccountNearBalance } from "../onchain.js";

export const systemRouter = Router();

systemRouter.get("/health", (_req, res) => {
  const chain = verifyChain();
  res.json({
    status: chain.valid && !isPaused() ? "ok" : "degraded",
    chain,
    paused: isPaused(),
    time: nowIso(),
    version: "1.0.0",
  });
});

systemRouter.get(
  "/home",
  asyncHandler(async (_req, res) => {
    res.json(await homeOnChain());
  }),
);

systemRouter.get(
  "/near-price",
  asyncHandler(async (_req, res) => {
    res.json(await getNearUsd());
  }),
);

systemRouter.get(
  "/chain",
  asyncHandler(async (_req, res) => {
    res.json(await chainStatus());
  }),
);

systemRouter.get(
  "/onchain/account/:accountId",
  asyncHandler(async (req, res) => {
    const accountId = z.string().min(2).max(64).regex(/^[a-zA-Z0-9._-]+$/).parse(req.params.accountId);
    const [nearBalance, quote] = await Promise.all([
      getAccountNearBalance(accountId),
      getNearUsd(),
    ]);
    res.json({
      accountId,
      nearBalance,
      nearUsd: quote.usd,
      usdMicro: Math.round((Number(BigInt(nearBalance)) / 1e24) * quote.usd * 1_000_000),
      nearUsdSource: quote.source,
      updatedAt: quote.updatedAt,
    });
  }),
);

systemRouter.get(
  "/onchain/market/:tokenId",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const tokenId = z.string().min(3).max(80).parse(req.params.tokenId);
    res.json(await getOnChainMarket(tokenId, req.user?.address ?? null));
  }),
);

systemRouter.get(
  "/chain/txs",
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        subject: z.string().max(120).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(12),
      })
      .parse(req.query);
    res.json({
      txs: query.subject
        ? latestChainTxsForSubject(query.subject, query.limit)
        : recentChainTxs(query.limit),
    });
  }),
);

systemRouter.get(
  "/tokens",
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        tier: z.enum(["seed", "rising", "viral"]).optional(),
        status: z.enum(["live", "bonding", "graduated", "prelaunch"]).optional(),
        community: z.enum(["community", "verified"]).optional(),
        sort: z.enum(["trending", "new", "volume", "stars", "gainers", "progress", "marketcap"]).optional(),
        q: z.string().max(80).optional(),
        page: z.coerce.number().int().min(1).max(10000).default(1),
        pageSize: z.coerce.number().int().min(1).max(48).default(24),
      })
      .parse(req.query);
    res.json(await exploreOnChain(query));
  }),
);

systemRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const q = z.string().max(80).catch("").parse(req.query.q);
    res.json({ results: await searchOnChain(q, 8) });
  }),
);

systemRouter.get("/king", (_req, res) => {
  res.json({ king: null });
});

systemRouter.get(
  "/leaderboard",
  asyncHandler(async (_req, res) => {
    res.json({ traders: await leaderboardOnChain(24), chain: verifyChain() });
  }),
);

systemRouter.get(
  "/portfolio",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ ...(await portfolioOnChain(req.user!)), user: getUserProfile(req.user!) });
  }),
);

systemRouter.get(
  "/nft/:id/metadata",
  asyncHandler(async (req, res) => {
    const token = getTokenById(String(req.params.id));
    if (!token) {
      res.status(404).json({ error: "NFT metadata not found.", code: "NOT_FOUND" });
      return;
    }
    const metadata = nftMetadata(token.id);
    if (!metadata) {
      res.status(404).json({ error: "NFT metadata not found.", code: "NOT_FOUND" });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.json(metadata);
  }),
);

systemRouter.get(
  "/ledger",
  asyncHandler(async (_req, res) => {
    const rows = db
      .prepare(
        "SELECT seq, id, type, aggregate, digest, created_at FROM chain_receipts ORDER BY seq DESC LIMIT 40",
      )
      .all() as Array<{
      seq: number;
      id: string;
      type: string;
      aggregate: string;
      digest: string;
      created_at: string;
    }>;
    const verification = verifyChain();
    res.json({
      oraclePublicKey: oracleKey().publicKeyHex,
      verification,
      receipts: rows.map((row) => ({
        seq: row.seq,
        id: row.id,
        type: row.type,
        aggregate: row.aggregate,
        digest: row.digest,
        createdAt: row.created_at,
      })),
    });
  }),
);

function requireAdmin(req: import("express").Request): void {
  const provided = req.get("x-admin-token") ?? req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!provided || provided.length !== config.adminToken.length) {
    throw new ApiError("Admin token required.", 401, "ADMIN_REQUIRED");
  }
  if (
    !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(config.adminToken))
  ) {
    throw new ApiError("Invalid admin token.", 403, "ADMIN_FORBIDDEN");
  }
}

systemRouter.post(
  "/admin/pause",
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const body = z.object({ paused: z.boolean(), reason: z.string().max(200).optional() }).parse(req.body);
    setConfig("paused", String(body.paused));
    appendReceipt("circuit_breaker", "platform", {
      paused: body.paused,
      reason: body.reason ?? null,
      actor: "admin",
    });
    res.json({ paused: body.paused });
  }),
);

systemRouter.post(
  "/admin/sync",
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const limit = z.coerce.number().int().min(1).max(10).catch(3).parse(req.query.limit);
    const results = await syncDueRepos(limit);
    res.json({ synced: results });
  }),
);

systemRouter.post(
  "/admin/metrics",
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    refreshVolume24h();
    res.json({ ok: true, time: nowIso() });
  }),
);

void writeLimiter;
void getSessionUser;
