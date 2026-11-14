import { db } from "./db.js";
import { getRepo, getTokenRow, tokenSummary } from "./tokens.js";
import type { KingData, TokenSummary } from "../shared/types.js";

interface KingCache {
  data: KingData | null;
  at: number;
  hourEnd: string;
}

let cache: KingCache | null = null;
const CACHE_MS = 12_000;

export interface KingCandidate {
  tokenId: string;
  slug: string;
  volume1hMicro: number;
  starVelocity1h: number;
  score: number;
}

export function kingCandidates(now = Date.now()): KingCandidate[] {
  const since = new Date(now - 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT t.id AS token_id, t.slug, t.name, t.status, t.launch_at, r.sync_state,
              r.star_velocity_1h,
              COALESCE((SELECT SUM(tr.usd_micro) FROM trades tr WHERE tr.token_id = t.id AND tr.created_at >= ?), 0) AS volume_1h
       FROM tokens t JOIN repos r ON r.id = t.repo_id
       WHERE t.status IN ('bonding','graduated') AND r.sync_state = 'ok'
         AND (t.launch_at IS NULL OR t.launch_at <= ?)
       ORDER BY volume_1h DESC LIMIT 30`,
    )
    .all(since, new Date(now).toISOString()) as Array<{
    token_id: string;
    slug: string;
    name: string;
    volume_1h: number;
    star_velocity_1h: number;
  }>;
  return rows
    .map((row) => {
      const volumeUsd = Number(row.volume_1h) / 1_000_000;
      const velocity = Math.max(0, Number(row.star_velocity_1h));
      const score = Math.round(volumeUsd + velocity * 100);
      return {
        tokenId: row.token_id,
        slug: row.slug,
        volume1hMicro: Number(row.volume_1h),
        starVelocity1h: velocity,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function hourEndIso(now = Date.now()): string {
  const end = new Date(now);
  end.setUTCMinutes(0, 0, 0);
  end.setUTCHours(end.getUTCHours() + 1);
  return end.toISOString();
}

export function getKing(force = false): KingData | null {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const candidates = kingCandidates();
  const top = candidates[0];
  let data: KingData | null = null;
  if (top && (top.volume1hMicro > 0 || top.starVelocity1h > 0)) {
    const token = getTokenRow(top.tokenId);
    const repo = token ? getRepo(token.repo_id) : null;
    if (token && repo) {
      const summary: TokenSummary = tokenSummary(token, repo, {
        isKing: true,
        change24hBps: undefined,
      });
      const now = new Date();
      data = {
        token: summary,
        volume1hMicro: top.volume1hMicro,
        starVelocity1h: top.starVelocity1h,
        score: top.score,
        since: cache?.data?.token.id === token.id ? cache.data.since : now.toISOString(),
        endsAt: hourEndIso(now.getTime()),
      };
    }
  }
  cache = { data, at: Date.now(), hourEnd: hourEndIso() };
  return data;
}

export function isKingToken(tokenId: string): boolean {
  return getKing()?.token.id === tokenId;
}

export function invalidateKing(): void {
  cache = null;
}
