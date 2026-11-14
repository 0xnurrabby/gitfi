import { rateLimit } from "express-rate-limit";

export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 180,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests. Slow down for a moment.", code: "RATE_LIMITED" },
});

export const authLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 40,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Try again in a few minutes.", code: "RATE_LIMITED" },
});

export const writeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 70,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many actions. Wait a moment and retry.", code: "RATE_LIMITED" },
});

export const tradeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 40,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Trading rate limit reached. Take a breath.", code: "RATE_LIMITED" },
});

export const githubLimiter = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "GitHub verification limit reached. Try again in a minute.", code: "RATE_LIMITED" },
});

export const chatLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Slow the room down a little.", code: "RATE_LIMITED" },
});

export const claimLimiter = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many claim attempts. Wait a minute.", code: "RATE_LIMITED" },
});
