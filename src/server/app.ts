import express from "express";
import compression from "compression";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { uploadDir } from "./db.js";
import { errorHandler, notFoundHandler } from "./http.js";
import { apiLimiter } from "./security.js";
import { authRouter } from "./routes/auth.js";
import { marketRouter } from "./routes/market.js";
import { repoRouter } from "./routes/repo.js";
import { communityRouter } from "./routes/community.js";
import { systemRouter } from "./routes/system.js";
import { activateDueLaunches } from "./tokens.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "blob:"],
          styleSrc: ["'self'", "'unsafe-inline'", "https:"],
          imgSrc: ["'self'", "data:", "blob:", "https:"],
          fontSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "ws:", "wss:", "https:"],
          frameSrc: ["'self'", "https:"],
          childSrc: ["'self'", "https:"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          mediaSrc: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use(compression({ threshold: 1024 }));
  app.use(cookieParser(config.sessionSecret));
  app.use(express.json({ limit: "9mb" }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  });

  app.use((req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      next();
      return;
    }
    const origin = req.get("origin");
    if (!origin) {
      next();
      return;
    }
    try {
      const originUrl = new URL(origin);
      const host = req.get("host");
      const allowed =
        origin === config.appUrl ||
        originUrl.host === host ||
        ["localhost:5173", "127.0.0.1:5173", "localhost:8787", "127.0.0.1:8787"].includes(
          originUrl.host,
        );
      if (!allowed) {
        res.status(403).json({ error: "Cross-origin request rejected.", code: "ORIGIN_REJECTED" });
        return;
      }
    } catch {
      res.status(403).json({ error: "Invalid request origin.", code: "ORIGIN_REJECTED" });
      return;
    }
    next();
  });

  const logoStatic = express.static(uploadDir, {
    immutable: true,
    maxAge: "365d",
    index: false,
    dotfiles: "deny",
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  });
  app.use("/cdn/logo", logoStatic);

  app.use("/api", apiLimiter);
  let lastLaunchSweep = 0;
  app.use("/api", (req, res, next) => {
    try {
      if (Date.now() - lastLaunchSweep > 2_000) {
        activateDueLaunches();
        lastLaunchSweep = Date.now();
      }
    } catch {
    }
    next();
  });
  app.get("/api/platform", (req, res) => {
    void req;
    res.json({
      name: "GitFi.fun",
      network: config.nearNetwork,
      contractId: config.nearContractId,
      marketContractId: config.nearMarketContractId,
      platformFeeAddress: config.platformFeeAddress,
      launchFeeYocto: config.launchFeeYocto,
      tradeFeeBps: config.tradeFeeBps,
      creatorFeeBps: config.creatorFeeBps,
      platformFeeBps: config.platformFeeBps,
      stakerFeeBps: config.stakerFeeBps,
      demoMode: config.demoMode,
      chainEnabled: config.nearChainEnabled,
      explorerUrl: config.nearExplorerUrl,
      contractUrl: `${config.nearExplorerUrl.replace(/\/$/, "")}/accounts/${config.nearContractId}`,
      docs: "https://github.com/gitfi-fun",
    });
  });
  app.use("/api/auth", authRouter);
  app.use("/api", repoRouter);
  app.use("/api", marketRouter);
  app.use("/api", communityRouter);
  app.use("/api", systemRouter);

  const clientDir = path.join(config.root, "dist", "client");
  const indexHtml = path.join(clientDir, "index.html");
  const docsDir = path.join(clientDir, "docs");
  if (fs.existsSync(docsDir)) {
    app.use((req, res, next) => {
      if (!req.hostname.toLowerCase().startsWith("docs.")) {
        next();
        return;
      }
      express.static(docsDir, { maxAge: "1h" })(req, res, next);
    });
    app.use("/docs", express.static(docsDir, { maxAge: "1h" }));
  }
  if (fs.existsSync(indexHtml)) {
    app.use(
      express.static(clientDir, {
        index: false,
        maxAge: "1h",
        setHeaders(res, filePath) {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        },
      }),
    );
    app.get(/.*/, (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/cdn") || req.path.startsWith("/ws")) {
        next();
        return;
      }
      res.sendFile(indexHtml);
    });
  } else {
    app.get("/", (_req, res) => {
      res.json({
        name: "GitFi.fun API",
        status: "ready",
        ui: "Run the Vite client on http://localhost:5173",
      });
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
