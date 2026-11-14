import http from "node:http";
import { config, log, warn } from "./config.js";
import { initDb, db, nowIso } from "./db.js";
import { createApp } from "./app.js";
import { attachRealtime, closeRealtime } from "./realtime.js";
import { seedDemoData } from "./seed.js";
import { refreshVolume24h } from "./engine.js";
import { syncDueRepos } from "./star.js";
import { activateDueLaunches } from "./tokens.js";
import { backfillDeeds, backfillAnchors } from "./chain.js";

async function main(): Promise<void> {
  initDb();
  // Sandbox login has been removed. Invalidate any pre-existing sandbox sessions
  // so every browser must connect a real NEAR wallet.
  try {
    const removed = db
      .prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE is_sandbox = 1)")
      .run();
    if (Number(removed.changes) > 0) log(`cleared ${removed.changes} legacy sandbox session(s)`);
  } catch {
    // Session cleanup must never block startup.
  }
  if (config.seedDemo) {
    await seedDemoData();
  }
  refreshVolume24h();
  backfillDeeds();
  backfillAnchors();

  if (process.argv.includes("--seed-only")) {
    log("seed-only run complete");
    process.exit(0);
  }

  const app = createApp();
  const server = http.createServer(app);
  attachRealtime(server);

  const metricsTimer = setInterval(() => {
    try {
      refreshVolume24h();
      activateDueLaunches();
    } catch (error) {
      warn(`metrics refresh failed: ${(error as Error).message}`);
    }
  }, 2 * 60_000);
  metricsTimer.unref?.();

  const cleanupTimer = setInterval(() => {
    try {
      const now = nowIso();
      db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
      db.prepare("DELETE FROM auth_challenges WHERE expires_at < ? AND used_at IS NOT NULL").run(now);
      db.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").run(
        new Date(Date.now() - 7 * 86_400_000).toISOString(),
      );
    } catch (error) {
      warn(`cleanup failed: ${(error as Error).message}`);
    }
  }, 6 * 3_600_000);
  cleanupTimer.unref?.();

  const syncTimer = setInterval(() => {
    syncDueRepos(1).catch((error) => warn(`GitHub sync failed: ${(error as Error).message}`));
  }, 10 * 60_000);
  syncTimer.unref?.();

  const initialSync = setTimeout(() => {
    syncDueRepos(1).catch((error) => warn(`Initial GitHub sync failed: ${(error as Error).message}`));
  }, 45_000);
  initialSync.unref?.();

  server.listen(config.port, () => {
    log(`GitFi API listening on http://localhost:${config.port}`);
    log(`network: ${config.nearNetwork} · demo mode: ${config.demoMode}`);
  });

  const shutdown = (signal: string) => {
    log(`${signal} received; shutting down`);
    clearInterval(metricsTimer);
    clearInterval(cleanupTimer);
    clearInterval(syncTimer);
    clearTimeout(initialSync);
    closeRealtime();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[gitfi] fatal startup error", error);
  process.exit(1);
});
