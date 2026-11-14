import { Router } from "express";
import { z } from "zod";
import { requireAuth, optionalAuth, type UserRow } from "../auth.js";
import { db, nowIso, withTransaction } from "../db.js";
import { asyncHandler, ApiError } from "../http.js";
import { availableTokens } from "../engine.js";
import { appendReceipt } from "../ledger.js";
import { getTokenById, type TokenRow } from "../tokens.js";
import { publish } from "../realtime.js";
import { chatLimiter, writeLimiter } from "../security.js";
import { randomId } from "../auth.js";
import type { Bounty, BountySubmission, ChatMessage, Proposal } from "../../shared/types.js";

export const communityRouter = Router();

function tokenOr404(id: string): TokenRow {
  const token = getTokenById(id) ?? (db.prepare("SELECT * FROM tokens WHERE slug = ?").get(id) as TokenRow | undefined);
  if (!token) throw new ApiError("Token not found.", 404, "TOKEN_NOT_FOUND");
  return token;
}

function holdingAmount(userId: string, tokenId: string): number {
  const row = db
    .prepare("SELECT amount_micro FROM holdings WHERE user_id = ? AND token_id = ?")
    .get(userId, tokenId) as { amount_micro: number } | undefined;
  return row?.amount_micro ?? 0;
}

function chatAccess(user: UserRow | null, token: TokenRow): boolean {
  if (!user) return false;
  if (token.owner_wallet && token.owner_wallet === user.address) return true;
  return holdingAmount(user.id, token.id) >= token.vip_threshold_micro && token.vip_threshold_micro > 0;
}

communityRouter.get(
  "/tokens/:id/chat",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const token = tokenOr404(String(req.params.id));
    const allowed = chatAccess(req.user ?? null, token);
    if (!allowed) {
      res.json({
        access: false,
        thresholdMicro: token.vip_threshold_micro,
        holdingMicro: req.user ? holdingAmount(req.user.id, token.id) : 0,
        messages: [],
      });
      return;
    }
    const rows = db
      .prepare(
        `SELECT c.*, u.display_name FROM chat_messages c JOIN users u ON u.id = c.user_id
         WHERE c.token_id = ? ORDER BY c.created_at ASC LIMIT 100`,
      )
      .all(token.id) as Array<{
      id: string;
      wallet: string;
      display_name: string;
      message: string;
      created_at: string;
    }>;
    res.json({
      access: true,
      thresholdMicro: token.vip_threshold_micro,
      holdingMicro: req.user ? holdingAmount(req.user!.id, token.id) : 0,
      messages: rows.map((row) => ({
        id: row.id,
        wallet: row.wallet,
        displayName: row.display_name,
        avatarUrl: "",
        message: row.message,
        createdAt: row.created_at,
        role: row.wallet === token.owner_wallet ? "developer" : "holder",
      })) satisfies ChatMessage[],
    });
  }),
);

communityRouter.post(
  "/tokens/:id/chat",
  chatLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const token = tokenOr404(String(req.params.id));
    if (!chatAccess(req.user!, token)) {
      throw new ApiError(
        `The VIP room unlocks at ${(token.vip_threshold_micro / 1_000_000).toLocaleString()} $${token.ticker}.`,
        403,
        "VIP_REQUIRED",
      );
    }
    const body = z
      .object({ message: z.string().trim().min(1, "Write a message.").max(500, "Keep messages under 500 characters.") })
      .parse(req.body);
    if (/<script|javascript:|onerror=/i.test(body.message)) {
      throw new ApiError("Message contains unsupported markup.", 400, "UNSAFE_CONTENT");
    }
    const id = randomId("msg_");
    const now = nowIso();
    db.prepare(
      "INSERT INTO chat_messages(id, token_id, user_id, wallet, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, token.id, req.user!.id, req.user!.address, body.message, now);
    const payload: ChatMessage = {
      id,
      wallet: req.user!.address,
      displayName: req.user!.display_name,
      avatarUrl: req.user!.avatar_url ?? "",
      message: body.message,
      createdAt: now,
      role: req.user!.address === token.owner_wallet ? "developer" : "holder",
    };
    publish({ type: "chat", tokenId: token.id, data: payload });
    res.status(201).json({ message: payload });
  }),
);

function bountySubmissions(bountyId: string): BountySubmission[] {
  const rows = db
    .prepare(
      `SELECT s.*, u.display_name FROM bounty_submissions s JOIN users u ON u.id = s.user_id
       WHERE s.bounty_id = ? ORDER BY s.created_at DESC`,
    )
    .all(bountyId) as Array<{
    id: string;
    wallet: string;
    display_name: string;
    url: string;
    note: string | null;
    created_at: string;
    selected: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    wallet: row.wallet,
    displayName: row.display_name,
    url: row.url,
    note: row.note,
    createdAt: row.created_at,
    selected: Boolean(row.selected),
  }));
}

function bountyView(
  row: {
    id: string;
    token_id: string;
    creator_wallet: string;
    title: string;
    description: string;
    reward_micro: number;
    status: string;
    claimant_wallet: string | null;
    submission_url: string | null;
    created_at: string;
    paid_at: string | null;
  },
  viewer: UserRow | null,
  token: TokenRow,
): Bounty {
  const creator = db
    .prepare("SELECT display_name FROM users WHERE address = ?")
    .get(row.creator_wallet) as { display_name: string } | undefined;
  const claimant = row.claimant_wallet
    ? (db.prepare("SELECT display_name FROM users WHERE address = ?").get(row.claimant_wallet) as {
        display_name: string;
      } | undefined)
    : undefined;
  return {
    id: row.id,
    tokenId: row.token_id,
    title: row.title,
    description: row.description,
    rewardMicro: row.reward_micro,
    status: row.status as Bounty["status"],
    creatorAddress: row.creator_wallet,
    creatorName: creator?.display_name ?? row.creator_wallet,
    claimantAddress: row.claimant_wallet,
    claimantName: claimant?.display_name ?? null,
    submissionUrl: row.submission_url,
    submissions: bountySubmissions(row.id),
    createdAt: row.created_at,
    paidAt: row.paid_at,
    canApprove:
      Boolean(viewer) &&
      viewer!.address === token.owner_wallet &&
      (row.status === "review" || row.status === "open"),
  };
}

communityRouter.get(
  "/tokens/:id/bounties",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const token = tokenOr404(String(req.params.id));
    const rows = db
      .prepare("SELECT * FROM bounties WHERE token_id = ? ORDER BY created_at DESC LIMIT 30")
      .all(token.id) as Array<Parameters<typeof bountyView>[0]>;
    res.json(rows.map((row) => bountyView(row, req.user ?? null, token)));
  }),
);

communityRouter.post(
  "/tokens/:id/bounties",
  writeLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const token = tokenOr404(String(req.params.id));
    if (!token.owner_wallet || token.owner_wallet !== req.user!.address) {
      throw new ApiError("Only the verified repository owner can escrow a bounty.", 403, "OWNER_ONLY");
    }
    const body = z
      .object({
        title: z.string().trim().min(4).max(90),
        description: z.string().trim().min(20).max(900),
        rewardTokens: z.number().int().positive().max(1_000_000_000),
      })
      .parse(req.body);
    const rewardMicro = body.rewardTokens * 1_000_000;
    if (!Number.isSafeInteger(rewardMicro)) throw new ApiError("Reward is too large.", 400, "INVALID_AMOUNT");
    const bountyId = randomId("bnt_");
    withTransaction(() => {
      const available = availableTokens(req.user!.id, token.id);
      if (available < BigInt(rewardMicro)) {
        throw new ApiError(
          "Not enough unlocked, unstaked tokens to escrow this bounty.",
          422,
          "INSUFFICIENT_TOKENS",
        );
      }
      db.prepare(
        "UPDATE holdings SET amount_micro = amount_micro - ?, updated_at = ? WHERE user_id = ? AND token_id = ?",
      ).run(rewardMicro, nowIso(), req.user!.id, token.id);
      const holderCountAfterEscrow = (
        db.prepare("SELECT COUNT(*) AS count FROM holdings WHERE token_id = ? AND amount_micro > 0").get(token.id) as {
          count: number;
        }
      ).count;
      db.prepare("UPDATE tokens SET holder_count = ? WHERE id = ?").run(holderCountAfterEscrow, token.id);
      db.prepare(
        `INSERT INTO bounties(id, token_id, creator_wallet, title, description, reward_micro, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      ).run(
        bountyId,
        token.id,
        req.user!.address,
        body.title,
        body.description,
        rewardMicro,
        nowIso(),
        nowIso(),
      );
      db.prepare(
        `INSERT INTO activities(id, token_id, type, actor_wallet, message, metadata_json, created_at)
         VALUES (?, ?, 'bounty', ?, ?, ?, ?)`,
      ).run(
        randomId("act_"),
        token.id,
        req.user!.address,
        `escrowed a ${body.rewardTokens.toLocaleString()} $${token.ticker} bounty: ${body.title}`,
        JSON.stringify({ rewardMicro }),
        nowIso(),
      );
      appendReceipt("bounty.escrow", bountyId, {
        bountyId,
        tokenId: token.id,
        creator: req.user!.address,
        rewardMicro,
      });
    });
    const row = db.prepare("SELECT * FROM bounties WHERE id = ?").get(bountyId) as Parameters<typeof bountyView>[0];
    const view = bountyView(row, req.user!, token);
    publish({ type: "bounty", tokenId: token.id, data: view });
    res.status(201).json(view);
  }),
);

communityRouter.post(
  "/bounties/:id/submit",
  writeLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = db.prepare("SELECT * FROM bounties WHERE id = ?").get(String(req.params.id)) as
      | {
          id: string;
          token_id: string;
          creator_wallet: string;
          status: string;
        }
      | undefined;
    if (!row) throw new ApiError("Bounty not found.", 404, "BOUNTY_NOT_FOUND");
    if (row.status === "paid") throw new ApiError("This bounty is already paid.", 409, "BOUNTY_PAID");
    if (row.creator_wallet === req.user!.address) {
      throw new ApiError("You cannot submit to your own bounty.", 422, "OWN_BOUNTY");
    }
    const body = z
      .object({
        url: z.string().url("Submit a valid URL.").max(500),
        note: z.string().trim().max(500).optional(),
      })
      .parse(req.body);
    const id = randomId("bsb_");
    const now = nowIso();
    db.prepare(
      `INSERT INTO bounty_submissions(id, bounty_id, user_id, wallet, url, note, created_at, selected)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(id, row.id, req.user!.id, req.user!.address, body.url, body.note ?? null, now);
    db.prepare(
      "UPDATE bounties SET status = 'review', claimant_wallet = ?, submission_url = ?, updated_at = ? WHERE id = ?",
    ).run(req.user!.address, body.url, now, row.id);
    const token = getTokenById(row.token_id)!;
    publish({ type: "bounty", tokenId: row.token_id, data: { bountyId: row.id, status: "review" } });
    res.status(201).json({ id, status: "review", token: token.ticker });
  }),
);

communityRouter.post(
  "/bounties/:id/approve",
  writeLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = z.object({ submissionId: z.string() }).parse(req.body);
    const result = withTransaction(() => {
      const bounty = db.prepare("SELECT * FROM bounties WHERE id = ?").get(String(req.params.id)) as
        | {
            id: string;
            token_id: string;
            creator_wallet: string;
            reward_micro: number;
            status: string;
          }
        | undefined;
      if (!bounty) throw new ApiError("Bounty not found.", 404, "BOUNTY_NOT_FOUND");
      if (bounty.status === "paid") throw new ApiError("Bounty already paid.", 409, "BOUNTY_PAID");
      const token = getTokenById(bounty.token_id)!;
      if (token.owner_wallet !== req.user!.address) {
        throw new ApiError("Only the verified developer can approve this bounty.", 403, "OWNER_ONLY");
      }
      const submission = db
        .prepare("SELECT * FROM bounty_submissions WHERE id = ? AND bounty_id = ?")
        .get(body.submissionId, bounty.id) as
        | { id: string; user_id: string; wallet: string; url: string }
        | undefined;
      if (!submission) throw new ApiError("Submission not found.", 404, "SUBMISSION_NOT_FOUND");
      const now = nowIso();
      db.prepare(
        "UPDATE bounty_submissions SET selected = 1 WHERE id = ?",
      ).run(submission.id);
      db.prepare(
        "UPDATE bounties SET status = 'paid', claimant_wallet = ?, paid_at = ?, updated_at = ? WHERE id = ?",
      ).run(submission.wallet, now, now, bounty.id);
      // Move escrowed tokens into the contributor's holding.
      const existing = db
        .prepare("SELECT * FROM holdings WHERE user_id = ? AND token_id = ?")
        .get(submission.user_id, token.id) as
        | { amount_micro: number; cost_micro: number }
        | undefined;
      if (existing) {
        db.prepare(
          "UPDATE holdings SET amount_micro = amount_micro + ?, updated_at = ? WHERE user_id = ? AND token_id = ?",
        ).run(bounty.reward_micro, now, submission.user_id, token.id);
      } else {
        db.prepare(
          `INSERT INTO holdings(user_id, token_id, amount_micro, cost_micro, realized_pnl_micro, vesting_locked_micro, vesting_until, updated_at)
           VALUES (?, ?, ?, 0, 0, 0, NULL, ?)`,
        ).run(submission.user_id, token.id, bounty.reward_micro, now);
      }
      const holderCount = (
        db.prepare("SELECT COUNT(*) AS count FROM holdings WHERE token_id = ? AND amount_micro > 0").get(token.id) as {
          count: number;
        }
      ).count;
      db.prepare("UPDATE tokens SET holder_count = ? WHERE id = ?").run(holderCount, token.id);
      db.prepare("UPDATE users SET xp = xp + 200 WHERE id = ?").run(submission.user_id);
      db.prepare(
        `INSERT INTO activities(id, token_id, type, actor_wallet, message, metadata_json, created_at)
         VALUES (?, ?, 'bounty', ?, ?, ?, ?)`,
      ).run(
        randomId("act_"),
        token.id,
        req.user!.address,
        `paid a ${(bounty.reward_micro / 1_000_000).toLocaleString()} $${token.ticker} bounty to ${submission.wallet}`,
        JSON.stringify({ bountyId: bounty.id, submissionId: submission.id }),
        now,
      );
      appendReceipt("bounty.payout", bounty.id, {
        bountyId: bounty.id,
        tokenId: token.id,
        contributor: submission.wallet,
        rewardMicro: bounty.reward_micro,
      });
      return { bountyId: bounty.id, tokenId: token.id, rewardMicro: bounty.reward_micro };
    });
    const token = getTokenById(result.tokenId)!;
    const row = db.prepare("SELECT * FROM bounties WHERE id = ?").get(result.bountyId) as Parameters<typeof bountyView>[0];
    const view = bountyView(row, req.user!, token);
    publish({ type: "bounty", tokenId: token.id, data: view });
    res.json(view);
  }),
);

function proposalView(
  row: {
    id: string;
    token_id: string;
    creator_wallet: string;
    title: string;
    url: string;
    kind: string;
    status: string;
    closes_at: string;
    created_at: string;
  },
  viewer: UserRow | null,
): Proposal {
  const counts = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN choice = 'yes' THEN weight_micro ELSE 0 END),0) AS yes,
              COALESCE(SUM(CASE WHEN choice = 'no' THEN weight_micro ELSE 0 END),0) AS no
       FROM proposal_votes WHERE proposal_id = ?`,
    )
    .get(row.id) as { yes: number; no: number };
  const myVote = viewer
    ? (db
        .prepare("SELECT choice FROM proposal_votes WHERE proposal_id = ? AND user_id = ?")
        .get(row.id, viewer.id) as { choice: string } | undefined)
    : undefined;
  let status = row.status;
  if (status === "open" && new Date(row.closes_at).getTime() < Date.now()) {
    status = counts.yes > counts.no ? "passed" : "closed";
    db.prepare("UPDATE proposals SET status = ? WHERE id = ?").run(status, row.id);
  }
  return {
    id: row.id,
    tokenId: row.token_id,
    title: row.title,
    url: row.url,
    kind: row.kind as Proposal["kind"],
    status: status as Proposal["status"],
    creatorAddress: row.creator_wallet,
    votesYesMicro: counts.yes,
    votesNoMicro: counts.no,
    myVote: myVote?.choice === "yes" ? "yes" : myVote?.choice === "no" ? "no" : null,
    closesAt: row.closes_at,
    createdAt: row.created_at,
  };
}

communityRouter.get(
  "/tokens/:id/proposals",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const token = tokenOr404(String(req.params.id));
    const rows = db
      .prepare("SELECT * FROM proposals WHERE token_id = ? ORDER BY created_at DESC LIMIT 20")
      .all(token.id) as Array<Parameters<typeof proposalView>[0]>;
    res.json(rows.map((row) => proposalView(row, req.user ?? null)));
  }),
);

communityRouter.post(
  "/tokens/:id/proposals",
  writeLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const token = tokenOr404(String(req.params.id));
    if (token.tier === "seed") {
      throw new ApiError("Governance votes unlock at the Rising tier.", 422, "TIER_TOO_LOW");
    }
    if (holdingAmount(req.user!.id, token.id) < token.vip_threshold_micro) {
      throw new ApiError(
        `Hold at least ${(token.vip_threshold_micro / 1_000_000).toLocaleString()} $${token.ticker} to open a proposal.`,
        403,
        "HOLDING_TOO_SMALL",
      );
    }
    const body = z
      .object({
        title: z.string().trim().min(8).max(120),
        url: z.string().url("Link the PR or issue.").max(500),
        kind: z.enum(["pr", "issue", "feature"]),
        durationDays: z.union([z.literal(3), z.literal(7), z.literal(14)]).default(7),
      })
      .parse(req.body);
    if (!body.url.startsWith("https://github.com/")) {
      throw new ApiError("Proposals must link to GitHub.", 400, "INVALID_PROPOSAL_URL");
    }
    const id = randomId("prp_");
    const now = nowIso();
    db.prepare(
      `INSERT INTO proposals(id, token_id, creator_wallet, title, url, kind, status, closes_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).run(
      id,
      token.id,
      req.user!.address,
      body.title,
      body.url,
      body.kind,
      new Date(Date.now() + body.durationDays * 86_400_000).toISOString(),
      now,
    );
    const row = db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Parameters<typeof proposalView>[0];
    const view = proposalView(row, req.user!);
    publish({ type: "proposal", tokenId: token.id, data: view });
    res.status(201).json(view);
  }),
);

communityRouter.post(
  "/proposals/:id/vote",
  writeLimiter,
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = z.object({ choice: z.enum(["yes", "no"]) }).parse(req.body);
    const proposal = db.prepare("SELECT * FROM proposals WHERE id = ?").get(String(req.params.id)) as
      | {
          id: string;
          token_id: string;
          closes_at: string;
          status: string;
        }
      | undefined;
    if (!proposal) throw new ApiError("Proposal not found.", 404, "PROPOSAL_NOT_FOUND");
    if (proposal.status !== "open" || new Date(proposal.closes_at).getTime() < Date.now()) {
      throw new ApiError("This proposal is closed.", 409, "PROPOSAL_CLOSED");
    }
    const token = getTokenById(proposal.token_id)!;
    const weight = holdingAmount(req.user!.id, token.id);
    if (weight < token.vip_threshold_micro) {
      throw new ApiError(
        `Hold at least ${(token.vip_threshold_micro / 1_000_000).toLocaleString()} $${token.ticker} to vote.`,
        403,
        "HOLDING_TOO_SMALL",
      );
    }
    try {
      db.prepare(
        `INSERT INTO proposal_votes(proposal_id, user_id, wallet, weight_micro, choice, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(proposal.id, req.user!.id, req.user!.address, weight, input.choice, nowIso());
    } catch {
      throw new ApiError("You already voted on this proposal.", 409, "ALREADY_VOTED");
    }
    const row = db.prepare("SELECT * FROM proposals WHERE id = ?").get(proposal.id) as Parameters<typeof proposalView>[0];
    const view = proposalView(row, req.user!);
    publish({ type: "proposal", tokenId: token.id, data: view });
    res.json(view);
  }),
);
