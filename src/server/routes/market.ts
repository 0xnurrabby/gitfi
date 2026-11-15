import { Router } from "express";
import { z } from "zod";
import { optionalAuth, requireAuth } from "../auth.js";
import { db } from "../db.js";
import { asyncHandler } from "../http.js";
import { executeTrade, quoteTrade, stakeTokens, unstakeTokens } from "../engine.js";
import {
  chartData,
  tokenDetailById,
  tokenTabData,
  getUserProfile,
} from "../readers.js";
import { getKing, invalidateKing } from "../king.js";
import { publish } from "../realtime.js";
import { getTokenById, type TokenRow } from "../tokens.js";
import { tokenMetadata } from "../token-service.js";
import { tradeLimiter, writeLimiter } from "../security.js";
import type { UserRow } from "../auth.js";

export const marketRouter = Router();

for (const retired of [
  "/tokens/:id/chart",
  "/tokens/:id/tabs",
  "/tokens/:id/trades",
  "/tokens/:id/quote",
  "/tokens/:id/trade",
  "/tokens/:id/stake",
  "/tokens/:id/unstake",
]) {
  marketRouter.all(retired, (_req, res) => {
    res.status(410).json({
      error: "This endpoint moved on-chain.",
      code: "ONCHAIN_ONLY",
      market: "Use /api/onchain/market/:tokenId and sign trades with your NEAR wallet.",
    });
  });
}

marketRouter.get(
  "/tokens/:id",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const detail = tokenDetailById(String(req.params.id), req.user ?? null);
    if (!detail) {
      res.status(404).json({ error: "Token not found.", code: "TOKEN_NOT_FOUND" });
      return;
    }
    res.json(detail);
  }),
);

marketRouter.get(
  "/tokens/:id/chart",
  asyncHandler(async (req, res) => {
    const range = z
      .enum(["1H", "24H", "7D", "30D", "ALL"])
      .catch("24H")
      .parse(req.query.range);
    const detail = tokenDetailById(String(req.params.id), null);
    if (!detail) {
      res.status(404).json({ error: "Token not found.", code: "TOKEN_NOT_FOUND" });
      return;
    }
    res.json(chartData(detail.id, range));
  }),
);

marketRouter.get(
  "/tokens/:id/tabs",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const detail = tokenDetailById(String(req.params.id), req.user ?? null);
    if (!detail) {
      res.status(404).json({ error: "Token not found.", code: "TOKEN_NOT_FOUND" });
      return;
    }
    res.json(tokenTabData(detail.id));
  }),
);

marketRouter.get(
  "/tokens/:id/trades",
  asyncHandler(async (req, res) => {
    const detail = tokenDetailById(String(req.params.id), null);
    if (!detail) {
      res.status(404).json({ error: "Token not found.", code: "TOKEN_NOT_FOUND" });
      return;
    }
    res.json(tokenTabData(detail.id).trades);
  }),
);

const quoteSchema = z.object({
  side: z.enum(["buy", "sell"]),
  amountMicro: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  input: z.enum(["usd", "token"]),
});

marketRouter.post(
  "/tokens/:id/quote",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const body = quoteSchema.parse(req.body);
    const token = getTokenById(String(req.params.id)) ?? getTokenByIdBySlugFallback(String(req.params.id));
    if (!token) {
      res.status(404).json({ error: "Token not found.", code: "TOKEN_NOT_FOUND" });
      return;
    }
    res.json(quoteTrade(token.id, req.user ?? null, body));
  }),
);

const tradeSchema = quoteSchema.extend({
  idempotencyKey: z.string().min(8).max(80).optional(),
  minOutMicro: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

marketRouter.post(
  "/tokens/:id/trade",
  tradeLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = tradeSchema.parse(req.body);
    const token = getTokenById(String(req.params.id)) ?? getTokenByIdBySlugFallback(String(req.params.id));
    if (!token) {
      res.status(404).json({ error: "Token not found.", code: "TOKEN_NOT_FOUND" });
      return;
    }
    const key = body.idempotencyKey ?? req.get("idempotency-key") ?? undefined;
    const result = executeTrade(req.user!, token.id, body, key);
    for (const event of result.events) {
      publish({ type: event.type as "trade" | "token", tokenId: result.token.id, data: event.data });
    }
    invalidateKing();
    const king = getKing(true);
    publish({ type: "king", data: king });
    const freshUser = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user!.id) as unknown as UserRow;
    const detail = tokenDetailById(result.token.id, freshUser);
    res.json({
      ...result,
      tokenDetail: detail,
      user: getUserProfile(freshUser),
    });
  }),
);

marketRouter.post(
  "/tokens/:id/stake",
  writeLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        amountMicro: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        lockDays: z.union([z.literal(7), z.literal(30), z.literal(90)]),
      })
      .parse(req.body);
    const token = getTokenById(String(req.params.id)) ?? getTokenByIdBySlugFallback(String(req.params.id));
    if (!token) {
      res.status(404).json({ error: "Token not found.", code: "TOKEN_NOT_FOUND" });
      return;
    }
    const result = stakeTokens(req.user!, token.id, body.amountMicro, body.lockDays);
    publish({
      type: "token",
      tokenId: token.id,
      data: {
        tokenId: token.id,
        stakedMicro: result.totalStakedMicro,
        kind: "stake",
      },
    });
    const freshUser = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user!.id) as unknown as UserRow;
    res.json({ ...result, user: getUserProfile(freshUser), tokenDetail: tokenDetailById(token.id, freshUser) });
  }),
);

marketRouter.post(
  "/tokens/:id/unstake",
  writeLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = z
      .object({ amountMicro: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
      .parse(req.body);
    const token = getTokenById(String(req.params.id)) ?? getTokenByIdBySlugFallback(String(req.params.id));
    if (!token) {
      res.status(404).json({ error: "Token not found.", code: "TOKEN_NOT_FOUND" });
      return;
    }
    const result = unstakeTokens(req.user!, token.id, body.amountMicro);
    publish({
      type: "token",
      tokenId: token.id,
      data: { tokenId: token.id, stakedMicro: result.totalStakedMicro, kind: "unstake" },
    });
    const freshUser = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user!.id) as unknown as UserRow;
    res.json({ ...result, user: getUserProfile(freshUser), tokenDetail: tokenDetailById(token.id, freshUser) });
  }),
);

marketRouter.get(
  "/metadata/:id.json",
  asyncHandler(async (req, res) => {
    const token = getTokenById(String(req.params.id)) ?? getTokenByIdBySlugFallback(String(req.params.id));
    if (!token) {
      res.status(404).json({ error: "Metadata not found.", code: "NOT_FOUND" });
      return;
    }
    const metadata = tokenMetadata(token.id);
    if (!metadata) {
      res.status(404).json({ error: "Metadata not found.", code: "NOT_FOUND" });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.json(metadata);
  }),
);

function getTokenByIdBySlugFallback(idOrSlug: string) {
  const row = db
    .prepare("SELECT * FROM tokens WHERE slug = ?")
    .get(idOrSlug) as unknown as TokenRow | undefined;
  return row ?? null;
}
