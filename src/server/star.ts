import { db, nowIso } from "./db.js";
import { GithubError, loadGithubRepo, upsertRepo } from "./github.js";
import { appendReceipt } from "./ledger.js";
import { queueDeedFreeze, queueReceiptAnchor } from "./chain.js";
import { getRepo, getTokenById } from "./tokens.js";
import { TIERS, type Tier } from "../shared/economics.js";
import { randomId } from "./auth.js";
import { publish } from "./realtime.js";
import { log, warn } from "./config.js";

export interface StarSyncResult {
  tokenId: string;
  repo: string;
  stars: number;
  burnedMicro: number;
  events: number;
}

export function processStarMilestones(
  repoId: string,
  tokenId: string,
  stars: number,
): StarSyncResult {
  const repo = getRepo(repoId);
  const token = getTokenById(tokenId);
  if (!repo || !token) return { tokenId, repo: "", stars, burnedMicro: 0, events: 0 };
  const tier = token.tier as Tier;
  const config = TIERS[tier];
  const step = config.starStep;
  const milestone = Math.floor(stars / step) * step;
  const last = db
    .prepare("SELECT milestone FROM star_events WHERE token_id = ? ORDER BY milestone DESC LIMIT 1")
    .get(tokenId) as { milestone: number } | undefined;
  if (!last) {
    db.prepare(
      "INSERT INTO star_events(id, token_id, repo_id, stars, milestone, burn_micro, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    ).run(randomId("str_"), tokenId, repoId, stars, milestone, nowIso());
    return { tokenId, repo: repo.full_name, stars, burnedMicro: 0, events: 0 };
  }
  if (milestone <= last.milestone) {
    return { tokenId, repo: repo.full_name, stars, burnedMicro: 0, events: 0 };
  }
  if (repo.health_score < 45) {
    return { tokenId, repo: repo.full_name, stars, burnedMicro: 0, events: 0 };
  }
  const previousStars = last.milestone;
  const jump = Math.max(0, stars - previousStars);
  if (jump > Math.max(500, previousStars * 0.05)) {
    db.prepare(
      "INSERT INTO star_events(id, token_id, repo_id, stars, milestone, burn_micro, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    ).run(randomId("str_"), tokenId, repoId, stars, milestone, nowIso());
    return { tokenId, repo: repo.full_name, stars, burnedMicro: 0, events: 0 };
  }
  let burnedTotal = 0n;
  let reserve = BigInt(token.milestone_reserve_micro);
  const steps = Math.max(1, Math.floor((milestone - last.milestone) / step));
  const now = nowIso();
  const potential = BigInt(config.burnPerMilestoneMicro) * BigInt(steps);
  const burn = reserve < potential ? reserve : potential;
  if (burn > 0n) {
    reserve -= burn;
    burnedTotal = burn;
    db.prepare(
      "INSERT INTO star_events(id, token_id, repo_id, stars, milestone, burn_micro, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(randomId("str_"), tokenId, repoId, milestone, milestone, Number(burn), now);
    db.prepare(
      `INSERT INTO price_points(token_id, time, price_micro, volume_micro, type, label)
       VALUES (?, ?, ?, 0, 'star', ?)`,
    ).run(tokenId, Date.now(), token.last_price_micro, `★ ${milestone.toLocaleString()}`);
    db.prepare(
      `INSERT INTO activities(id, token_id, type, actor_wallet, message, metadata_json, created_at)
       VALUES (?, ?, 'star', NULL, ?, ?, ?)`,
    ).run(
      randomId("act_"),
      tokenId,
      `${repo.full_name} crossed ${milestone.toLocaleString()} GitHub stars — ${(Number(burn) / 1_000_000).toLocaleString()} $${token.ticker} burned`,
      JSON.stringify({ stars: milestone, burnMicro: Number(burn) }),
      now,
    );
    publish({
      type: "star",
      tokenId,
      data: {
        tokenId,
        repo: repo.full_name,
        ticker: token.ticker,
        slug: token.slug,
        stars: milestone,
        burnedMicro: Number(burn),
        logoUrl: token.logo_url,
        message: `crossed ${milestone.toLocaleString()} GitHub stars`,
      },
    });
  }
  if (burnedTotal > 0n) {
    db.prepare(
      "UPDATE tokens SET burned_micro = burned_micro + ?, milestone_reserve_micro = ?, updated_at = ? WHERE id = ?",
    ).run(Number(burnedTotal), Number(reserve), now, tokenId);
    const starReceipt = appendReceipt("star.milestone", tokenId, {
      tokenId,
      repo: repo.full_name,
      stars,
      burnedMicro: Number(burnedTotal),
      events: 1,
    });
    queueReceiptAnchor({
      kind: "star.milestone",
      aggregate: tokenId,
      digest: starReceipt.digest,
      subjectId: tokenId,
    });
  }
  return {
    tokenId,
    repo: repo.full_name,
    stars,
    burnedMicro: Number(burnedTotal),
    events: burnedTotal > 0n ? 1 : 0,
  };
}

export async function syncDueRepos(limit = 1): Promise<StarSyncResult[]> {
  const rows = db
    .prepare(
      `SELECT DISTINCT r.id AS repo_id, t.id AS token_id, r.full_name, r.last_synced_at
       FROM tokens t JOIN repos r ON r.id = t.repo_id
       WHERE r.sync_state = 'ok' AND (r.last_synced_at IS NULL OR r.last_synced_at < ?)
       ORDER BY r.last_synced_at ASC NULLS FIRST LIMIT ?`,
    )
    .all(new Date(Date.now() - 9 * 60 * 1000).toISOString(), limit) as Array<{
    repo_id: string;
    token_id: string;
    full_name: string;
    last_synced_at: string | null;
  }>;
  const results: StarSyncResult[] = [];
  for (const row of rows) {
    try {
      const data = await loadGithubRepo(row.full_name, { skipReadme: true, forceFresh: true });
      const { repoId } = upsertRepo(data);
      db.prepare("UPDATE repos SET sync_state = 'ok', updated_at = ? WHERE id = ?").run(
        nowIso(),
        repoId,
      );
      db.prepare("UPDATE tokens SET royalty_frozen = 0, updated_at = ? WHERE repo_id = ?").run(
        nowIso(),
        repoId,
      );
      const result = processStarMilestones(repoId, row.token_id, data.stars);
      results.push(result);
    } catch (error) {
      if (
        error instanceof GithubError &&
        (error.code === "REPO_NOT_FOUND" || error.code === "REPO_PRIVATE")
      ) {
        db.prepare(
          "UPDATE repos SET sync_state = 'hidden', updated_at = ?, last_synced_at = ? WHERE id = ?",
        ).run(nowIso(), nowIso(), row.repo_id);
        db.prepare(
          "UPDATE tokens SET royalty_frozen = 1, updated_at = ? WHERE repo_id = ?",
        ).run(nowIso(), row.repo_id);
        try {
          queueDeedFreeze({ tokenId: row.token_id, frozen: true, subjectId: row.token_id });
        } catch (error) {
          warn(`NEAR deed freeze failed: ${(error as Error).message}`);
        }
        publish({
          type: "token",
          data: {
            tokenId: row.token_id,
            repo: row.full_name,
            syncState: "hidden",
            royaltyFrozen: true,
          },
        });
        log(`repository hidden (private/deleted): ${row.full_name}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  return results;
}
