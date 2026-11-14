import { Router } from "express";
import { z } from "zod";
import {
  clearSessionCookie,
  createSession,
  optionalAuth,
  requireAuth,
  setSessionCookie,
} from "../auth.js";
import { db, nowIso } from "../db.js";
import { config } from "../config.js";
import { asyncHandler } from "../http.js";
import { getUserProfile } from "../readers.js";
import { getAccountPlatformInfo } from "./platform-info.js";
import { authLimiter } from "../security.js";
import { createNearAuthChallenge, verifyNearAuthChallenge } from "../near-auth.js";

export const authRouter = Router();

authRouter.get("/session", optionalAuth, (req, res) => {
  res.json({
    user: req.user ? getUserProfile(req.user) : null,
    platform: getAccountPlatformInfo(),
  });
});

const nearStartSchema = z.object({
  referral: z.string().max(16).optional().nullable(),
});

authRouter.post(
  "/near/start",
  authLimiter,
  asyncHandler(async (req, res) => {
    nearStartSchema.parse(req.body ?? {});
    res.json(createNearAuthChallenge());
  }),
);

const nearVerifySchema = z.object({
  challengeId: z.string().min(4).max(80),
  accountId: z.string().min(2).max(64),
  publicKey: z.string().min(9).max(120),
  signature: z.string().min(40).max(200),
  referral: z.string().max(16).optional().nullable(),
});

authRouter.post(
  "/near/verify",
  authLimiter,
  asyncHandler(async (req, res) => {
    const input = nearVerifySchema.parse(req.body);
    const { user, created } = await verifyNearAuthChallenge({
      challengeId: input.challengeId,
      accountId: input.accountId,
      publicKey: input.publicKey,
      signature: input.signature,
      referredBy: input.referral ?? undefined,
    });
    const session = createSession(user.id, req.get("user-agent"));
    const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
    setSessionCookie(
      res,
      session,
      req.secure || forwardedProto === "https" || config.appUrl.startsWith("https://"),
    );
    res.json({
      user: getUserProfile(user),
      created,
      platform: getAccountPlatformInfo(),
      wallet: "near",
    });
  }),
);

authRouter.post("/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

const profileSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(2, "Display name must be at least 2 characters.")
    .max(28, "Display name must be 28 characters or fewer.")
    .regex(/^[a-zA-Z0-9 _.-]+$/, "Display name contains unsupported characters."),
  bio: z.string().trim().max(280).optional(),
});

authRouter.patch(
  "/profile",
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = profileSchema.parse(req.body);
    db.prepare("UPDATE users SET display_name = ?, bio = ?, updated_at = ? WHERE id = ?").run(
      input.displayName,
      input.bio ?? null,
      nowIso(),
      req.user!.id,
    );
    const fresh = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user!.id) as typeof req.user;
    res.json({ user: getUserProfile(fresh!) });
  }),
);
