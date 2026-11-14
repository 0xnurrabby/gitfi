import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Check,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Code2,
  ExternalLink,
  FileCode2,
  GitBranch,
  GitPullRequest,
  Info,
  LockKeyhole,
  MessageSquare,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  ThumbsDown,
  ThumbsUp,
  Trophy,
  Users,
  Wallet,
  X,
} from "lucide-react";
import clsx from "clsx";
import type {
  Bounty,
  BountySubmission,
  ChatMessage,
  HolderPosition,
  Proposal,
  TokenDetail,
  TokenTabData,
  Trade,
  UserProfile,
} from "../../shared/types.js";
import { api, ApiRequestError, qs } from "../lib/api.js";
import {
  formatPercent,
  formatPrice,
  formatTimeAgo,
  formatTokens,
  formatUsd,
  shortNumber,
  truncateAddress,
} from "../../shared/format.js";
import { useAuth } from "../contexts/AuthContext.js";
import { useToast } from "../contexts/ToastContext.js";
import { useRealtimeEvent } from "../contexts/RealtimeContext.js";
import { ActivityFeed } from "./Market.js";
import { AssetLogo } from "./AssetLogo.js";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  ProgressBar,
  Skeleton,
  Tabs,
} from "./ui.js";

type Tab = "activity" | "holders" | "chat" | "bounties" | "votes";

export function CommunitySection({ token }: { token: TokenDetail }) {
  const [tab, setTab] = useState<Tab>("activity");
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const tabsQuery = useQuery({
    queryKey: ["tokenTabs", token.id],
    queryFn: () => api<TokenTabData>(`/api/tokens/${token.id}/tabs`),
    staleTime: 15_000,
  });

  const bountiesQuery = useQuery({
    queryKey: ["bounties", token.id],
    queryFn: () => api<Bounty[]>(`/api/tokens/${token.id}/bounties`),
    staleTime: 15_000,
    enabled: tab === "bounties",
  });

  const proposalsQuery = useQuery({
    queryKey: ["proposals", token.id],
    queryFn: () => api<Proposal[]>(`/api/tokens/${token.id}/proposals`),
    staleTime: 15_000,
    enabled: tab === "votes",
  });

  useEffect(() => {
    if (!tabsQuery.data) return;
    queryClient.setQueryData(["tokenTabs", token.id], tabsQuery.data);
  }, [queryClient, tabsQuery.data, token.id]);

  const tabs = [
    { id: "activity" as const, label: "Live activity" },
    { id: "holders" as const, label: "Holders", count: token.holderCount },
    { id: "chat" as const, label: "VIP dev room" },
    { id: "bounties" as const, label: "Bounties" },
    { id: "votes" as const, label: token.tier === "seed" ? "Votes · rising+" : "PR / issue votes" },
  ];

  return (
    <section className="community-section">
      <div className="community-head">
        <div>
          <span className="eyebrow">Inside the asset</span>
          <h2>The people behind the price.</h2>
        </div>
        <div className="community-head-meta mono">
          <span><Users size={12} /> {token.holderCount} HOLDERS</span>
          <span><MessageSquare size={12} /> STAKE-GATED</span>
        </div>
      </div>
      <Tabs tabs={tabs} active={tab} onChange={setTab} className="community-tabs" />
      <div className="community-panel">
        {tab === "activity" ? (
          <ActivityTab token={token} data={tabsQuery.data} loading={tabsQuery.isLoading} />
        ) : null}
        {tab === "holders" ? (
          <HoldersTab holders={tabsQuery.data?.holders ?? []} loading={tabsQuery.isLoading} user={user} />
        ) : null}
        {tab === "chat" ? <ChatTab token={token} /> : null}
        {tab === "bounties" ? (
          <BountiesTab
            token={token}
            bounties={bountiesQuery.data ?? []}
            loading={bountiesQuery.isLoading}
          />
        ) : null}
        {tab === "votes" ? (
          <VotesTab
            token={token}
            proposals={proposalsQuery.data ?? []}
            loading={proposalsQuery.isLoading}
          />
        ) : null}
      </div>
    </section>
  );
}

function ActivityTab({
  token,
  data,
  loading,
}: {
  token: TokenDetail;
  data?: TokenTabData;
  loading?: boolean;
}) {
  const [view, setView] = useState<"activity" | "trades">("activity");
  return (
    <div className="activity-tab">
      <div className="subtabs">
        <button
          className={clsx("subtab", view === "activity" && "subtab-active")}
          onClick={() => setView("activity")}
        >
          Protocol feed
        </button>
        <button
          className={clsx("subtab", view === "trades")}
          onClick={() => setView("trades")}
        >
          Trades
        </button>
        <span className="subtabs-meta mono">{formatUsd(token.volume24hMicro, { compact: true })} VOL / 24H</span>
      </div>
      <div className="activity-tab-grid">
        {view === "activity" ? (
          <ActivityFeed items={data?.activity ?? []} loading={loading} compact showHeader={false} />
        ) : (
          <TradeList trades={data?.trades ?? []} loading={loading} ticker={token.ticker} />
        )}
        <div className="activity-side-stat">
          <div className="activity-side-head">
            <span className="eyebrow">Market pulse</span>
            <span className="signal-dot" />
          </div>
          <div className="pulse-big mono">{formatUsd(token.volume24hMicro, { compact: true })}</div>
          <span className="pulse-label">24H VOLUME</span>
          <div className="pulse-grid">
            <div><span>MARKET CAP</span><strong className="mono">{formatUsd(token.marketCapMicro, { compact: true })}</strong></div>
            <div><span>STAKED</span><strong className="mono">{formatPercent((token.totalStakedMicro / token.circulation.totalSupplyMicro) * 10_000)}</strong></div>
            <div><span>BURNED</span><strong className="mono">{formatTokens(token.burnedMicro, { compact: true })}</strong></div>
            <div><span>HOLDERS</span><strong className="mono">{token.holderCount}</strong></div>
          </div>
          <div className="pulse-foot">
            <BadgeCheck size={12} /> Settled by oracle-backed ledger
          </div>
        </div>
      </div>
    </div>
  );
}

function TradeList({
  trades,
  loading,
  ticker,
}: {
  trades: Trade[];
  loading?: boolean;
  ticker: string;
}) {
  if (loading) {
    return (
      <div className="trade-list">
        {Array.from({ length: 7 }).map((_, index) => (
          <div className="trade-list-row" key={index}>
            <Skeleton style={{ width: 48 }} />
            <Skeleton style={{ width: 110 }} />
            <Skeleton style={{ width: 70 }} />
            <Skeleton style={{ width: 74 }} />
          </div>
        ))}
      </div>
    );
  }
  if (!trades.length) return <EmptyState title="No trades yet" body="The first buy opens this market." icon={<CircleDollarSign size={22} />} />;
  return (
    <div className="trade-list">
      <div className="trade-list-head mono">
        <span>SIDE</span><span>ACCOUNT</span><span className="text-right">AMOUNT</span><span className="text-right">TOTAL</span><span className="text-right">PRICE</span><span className="text-right">WHEN</span>
      </div>
      {trades.map((trade) => (
        <div className="trade-list-row" key={trade.id}>
          <span className={clsx("trade-side", trade.side === "buy" ? "text-positive" : "text-negative")}>
            {trade.side === "buy" ? <ArrowUpRight size={12} /> : <ArrowRight size={12} className="rotate-down" />}
            {trade.side.toUpperCase()}
          </span>
          <span className="trade-wallet mono">{trade.displayName || truncateAddress(trade.wallet)}</span>
          <span className="mono text-right">{formatTokens(trade.tokensMicro, { compact: true })} {ticker}</span>
          <span className="mono text-right">{formatUsd(trade.usdMicro)}</span>
          <span className="mono text-right">{formatPrice(trade.priceMicro)}</span>
          <span className="mono text-right muted">{formatTimeAgo(trade.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

function HoldersTab({
  holders,
  loading,
  user,
}: {
  holders: HolderPosition[];
  loading?: boolean;
  user: UserProfile | null;
}) {
  if (loading) {
    return (
      <div className="holder-list">
        {Array.from({ length: 7 }).map((_, index) => <Skeleton key={index} style={{ height: 50 }} />)}
      </div>
    );
  }
  if (!holders.length) return <EmptyState title="No holders yet" body="Holders appear here after the first buy." icon={<Users size={22} />} />;
  return (
    <div className="holder-list">
      <div className="holder-list-head mono">
        <span>#</span><span>HOLDER</span><span>SHARE</span><span>BALANCE</span><span>VALUE</span><span>STAKED</span><span>XP</span>
      </div>
      {holders.map((holder, index) => (
        <div className={clsx("holder-row", holder.isYou && "holder-row-you")} key={holder.address}>
          <span className="mono muted">{String(index + 1).padStart(2, "0")}</span>
          <div className="holder-ident">
            <span className="holder-avatar">{holder.displayName.slice(0, 2).toUpperCase()}</span>
            <div>
              <span className="holder-name">
                {holder.displayName}
                {holder.isOwner ? <Badge tone="lime" className="owner-badge">DEV</Badge> : null}
                {holder.isYou ? <Badge tone="outline">YOU</Badge> : null}
              </span>
              <span className="mono holder-address">{truncateAddress(holder.address, 9, 4)}</span>
            </div>
          </div>
          <span className="mono">{formatPercent(holder.shareBps)}</span>
          <span className="mono">{formatTokens(holder.amountMicro, { compact: true })}</span>
          <span className="mono">{formatUsd(holder.valueMicro, { compact: true })}</span>
          <span className="mono">{holder.stakedMicro ? formatPercent((holder.stakedMicro / holder.amountMicro) * 10_000) : "—"}</span>
          <span className="mono text-positive">{formatCompactNumber(holder.xp)}</span>
        </div>
      ))}
    </div>
  );
}

function formatCompactNumber(value: number): string {
  return value > 9999 ? shortNumber(value) : String(value);
}

function ChatTab({ token }: { token: TokenDetail }) {
  const { user, openAuth } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const chatQuery = useQuery({
    queryKey: ["chat", token.id],
    queryFn: () =>
      api<{
        access: boolean;
        thresholdMicro: number;
        holdingMicro: number;
        messages: ChatMessage[];
      }>(`/api/tokens/${token.id}/chat`),
    staleTime: 15_000,
  });

  useRealtimeEvent((event) => {
    if (event.type !== "chat" || event.tokenId !== token.id) return;
    const incoming = event.data as ChatMessage;
    if (!incoming?.id) return;
    queryClient.setQueryData<typeof chatQuery.data>(["chat", token.id], (current) => {
      if (!current) return current;
      if (current.messages.some((item) => item.id === incoming.id)) return current;
      return { ...current, messages: [...current.messages, incoming] };
    });
  });

  useEffect(() => {
    if (chatQuery.data?.access) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [chatQuery.data?.messages.length, chatQuery.data?.access]);

  const sendMutation = useMutation({
    mutationFn: () =>
      api<{ message: ChatMessage }>(`/api/tokens/${token.id}/chat`, {
        method: "POST",
        body: { message: message.trim() },
      }),
    onSuccess: (result) => {
      setMessage("");
      queryClient.setQueryData<typeof chatQuery.data>(["chat", token.id], (current) => {
        if (!current) return current;
        if (current.messages.some((item) => item.id === result.message.id)) return current;
        return { ...current, messages: [...current.messages, result.message] };
      });
    },
    onError: (error) => {
      notify(error instanceof ApiRequestError ? error.message : "Message failed.", {
        kind: "error",
      });
    },
  });

  if (chatQuery.isLoading) return <div className="chat-loading"><Skeleton style={{ height: 320 }} /></div>;
  if (!user) {
    return (
      <ChatLock
        token={token}
        holdingMicro={0}
        connected={false}
        onAction={openAuth}
      />
    );
  }
  if (!chatQuery.data?.access) {
    return (
      <ChatLock
        token={token}
        holdingMicro={chatQuery.data?.holdingMicro ?? token.myHolding?.amountMicro ?? 0}
        connected
        onAction={() => {
          document.querySelector(".trade-panel input")?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
      />
    );
  }
  return (
    <div className="chat-layout">
      <div className="chat-main">
        <div className="chat-head">
          <div>
            <span className="eyebrow"><LockKeyhole size={11} /> Token-gated</span>
            <h3>alpha/{token.ticker.toLowerCase()}</h3>
          </div>
          <div className="chat-head-right">
            <span className="chat-access mono"><ShieldCheck size={12} /> ACCESS VERIFIED</span>
            <span className="mono muted">{chatQuery.data.messages.length} messages</span>
          </div>
        </div>
        <div className="chat-messages">
          {chatQuery.data.messages.length === 0 ? (
            <div className="chat-empty">
              <MessageSquare size={22} />
              <strong>No messages yet.</strong>
              <span>Developer updates land here first.</span>
            </div>
          ) : (
            chatQuery.data.messages.map((message) => (
              <div
                key={message.id}
                className={clsx("chat-message", message.role === "developer" && "chat-message-dev")}
              >
                <span className="chat-avatar">{message.displayName.slice(0, 2).toUpperCase()}</span>
                <div className="chat-bubble">
                  <div className="chat-message-head">
                    <strong>{message.displayName}</strong>
                    {message.role === "developer" ? <Badge tone="lime">DEV</Badge> : null}
                    <span className="mono">{formatTimeAgo(message.createdAt)}</span>
                  </div>
                  <p>{message.message}</p>
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (message.trim() && !sendMutation.isPending) sendMutation.mutate();
          }}
        >
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value.slice(0, 500))}
            placeholder={`Message the ${token.ticker} room…`}
            rows={1}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (message.trim()) sendMutation.mutate();
              }
            }}
          />
          <span className="chat-charcount mono">{message.length}/500</span>
          <Button
            size="sm"
            variant="primary"
            type="submit"
            disabled={!message.trim() || sendMutation.isPending}
            loading={sendMutation.isPending}
            icon={<Send size={13} />}
          >
            Send
          </Button>
        </form>
      </div>
      <aside className="chat-side">
        <div className="chat-side-card">
          <span className="eyebrow">Room rules</span>
          <p>Be specific. Post reproductions, not price talk. The developer sees this room first.</p>
          <div className="chat-rule">
            <span className="mono">01</span><span>Threshold: {formatTokens(token.community.vipThresholdMicro, { compact: true })} ${token.ticker}</span>
          </div>
          <div className="chat-rule"><span className="mono">02</span><span>Holders + verified dev only</span></div>
          <div className="chat-rule"><span className="mono">03</span><span>No financial advice</span></div>
        </div>
        <div className="chat-beta-card">
          <Sparkles size={16} />
          <strong>Beta access</strong>
          <p>Holders get early builds, issue voting and direct maintainer access.</p>
        </div>
      </aside>
    </div>
  );
}

function ChatLock({
  token,
  holdingMicro,
  connected,
  onAction,
}: {
  token: TokenDetail;
  holdingMicro: number;
  connected: boolean;
  onAction: () => void;
}) {
  const needed = Math.max(0, token.community.vipThresholdMicro - holdingMicro);
  const progress = token.community.vipThresholdMicro
    ? Math.min(100, (holdingMicro / token.community.vipThresholdMicro) * 100)
    : 0;
  return (
    <div className="chat-lock">
      <div className="chat-lock-icon"><LockKeyhole size={26} /></div>
      <span className="eyebrow">Private alpha room</span>
      <h3>Read the room before the market does.</h3>
      <p>
        {connected
          ? `Hold ${formatTokens(token.community.vipThresholdMicro, { compact: true })} $${token.ticker} to unlock the developer’s private channel.`
          : "Connect and hold the access threshold to join the developer’s private channel."}
      </p>
      <div className="chat-lock-bar">
        <ProgressBar value={progress} tone="lime" />
        <div className="mono">
          <span>{formatTokens(holdingMicro, { compact: true })} held</span>
          <span>{formatTokens(token.community.vipThresholdMicro, { compact: true })} required</span>
        </div>
      </div>
      {connected ? (
        <div className="chat-lock-actions">
          <span className="mono text-positive">{needed > 0 ? `${formatTokens(needed, { compact: true })} ${token.ticker} to go` : "Access syncing…"}</span>
          <Button size="sm" variant="secondary" onClick={onAction}>Open trade panel</Button>
        </div>
      ) : (
        <Button size="sm" variant="primary" onClick={onAction}>Connect wallet</Button>
      )}
      <div className="chat-preview" aria-hidden="true">
        <div className="chat-preview-blur" />
        <div className="chat-preview-msg"><span>DEV</span><div /><div /></div>
        <div className="chat-preview-msg"><span>H</span><div /><div /></div>
        <div className="chat-preview-lock"><LockKeyhole size={13} /> Holder-only messages</div>
      </div>
    </div>
  );
}

function BountiesTab({
  token,
  bounties,
  loading,
}: {
  token: TokenDetail;
  bounties: Bounty[];
  loading?: boolean;
}) {
  const { user, openAuth } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [reward, setReward] = useState("");
  const [submissionFor, setSubmissionFor] = useState<Bounty | null>(null);
  const [submissionUrl, setSubmissionUrl] = useState("");
  const [submissionNote, setSubmissionNote] = useState("");
  const isOwner = Boolean(user && token.ownerAddress === user.address);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["bounties", token.id] });
    queryClient.invalidateQueries({ queryKey: ["token"] });
    queryClient.invalidateQueries({ queryKey: ["portfolio"] });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      api<Bounty>(`/api/tokens/${token.id}/bounties`, {
        method: "POST",
        body: {
          title,
          description,
          rewardTokens: Math.floor(Number.parseFloat(reward) || 0),
        },
      }),
    onSuccess: () => {
      setShowCreate(false);
      setTitle("");
      setDescription("");
      setReward("");
      refresh();
      notify("Bounty escrowed in the repo token.", { kind: "success" });
    },
    onError: (error) => notify(error instanceof ApiRequestError ? error.message : "Could not create bounty.", { kind: "error" }),
  });

  const submitMutation = useMutation({
    mutationFn: (bounty: Bounty) =>
      api(`/api/bounties/${bounty.id}/submit`, {
        method: "POST",
        body: { url: submissionUrl, note: submissionNote },
      }),
    onSuccess: () => {
      setSubmissionFor(null);
      setSubmissionUrl("");
      setSubmissionNote("");
      refresh();
      notify("Submission sent to the maintainer.", { kind: "success" });
    },
    onError: (error) => notify(error instanceof ApiRequestError ? error.message : "Submission failed.", { kind: "error" }),
  });

  const approveMutation = useMutation({
    mutationFn: ({ bounty, submission }: { bounty: Bounty; submission: BountySubmission }) =>
      api<Bounty>(`/api/bounties/${bounty.id}/approve`, {
        method: "POST",
        body: { submissionId: submission.id },
      }),
    onSuccess: () => {
      refresh();
      notify("Bounty paid. Escrowed tokens moved to the contributor.", { kind: "success" });
    },
    onError: (error) => notify(error instanceof ApiRequestError ? error.message : "Approval failed.", { kind: "error" }),
  });

  return (
    <div className="bounties-tab">
      <div className="bounty-toolbar">
        <div>
          <span className="eyebrow">Paid in ${token.ticker}</span>
          <h3>Fix the thing. Earn the token.</h3>
          <p>Bounties are escrowed by the developer and paid on approved work.</p>
        </div>
        {isOwner ? (
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)} icon={<Plus size={13} />}>
            Open bounty
          </Button>
        ) : !user ? (
          <Button variant="secondary" size="sm" onClick={openAuth}>Connect to submit</Button>
        ) : null}
      </div>

      {showCreate ? (
        <Card className="bounty-form">
          <div className="form-grid-2">
            <label className="field">
              <span>Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Harden the installer path" maxLength={90} />
            </label>
            <label className="field">
              <span>Reward in {token.ticker}</span>
              <input value={reward} onChange={(e) => setReward(e.target.value.replace(/[^0-9]/g, ""))} placeholder="50000" inputMode="numeric" />
            </label>
          </div>
          <label className="field">
            <span>Acceptance criteria</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="What must be true for this to be paid?" />
          </label>
          <div className="form-actions">
            <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => createMutation.mutate()}
              loading={createMutation.isPending}
              disabled={!title.trim() || !description.trim() || Number(reward) <= 0}
            >
              Escrow bounty
            </Button>
          </div>
        </Card>
      ) : null}

      {loading ? (
        <div className="bounty-grid">
          {Array.from({ length: 2 }).map((_, index) => <Skeleton key={index} style={{ height: 240 }} />)}
        </div>
      ) : bounties.length ? (
        <div className="bounty-grid">
          {bounties.map((bounty) => {
            const hasSubmitted = bounty.submissions.some((submission) => submission.wallet === user?.address);
            return (
              <Card className="bounty-card" key={bounty.id}>
                <div className="bounty-card-head">
                  <span className={`bounty-status bounty-status-${bounty.status}`}>
                    {bounty.status === "paid" ? <Check size={11} /> : bounty.status === "review" ? <Clock3 size={11} /> : <CircleDollarSign size={11} />}
                    {bounty.status}
                  </span>
                  <span className="mono bounty-reward">{formatTokens(bounty.rewardMicro, { compact: true })} ${token.ticker}</span>
                </div>
                <h4>{bounty.title}</h4>
                <p>{bounty.description}</p>
                <div className="bounty-meta mono">
                  <span>BY {truncateAddress(bounty.creatorAddress, 7, 4)}</span>
                  <span>{formatTimeAgo(bounty.createdAt)}</span>
                  <span>{bounty.submissions.length} SUBMISSION{bounty.submissions.length === 1 ? "" : "S"}</span>
                </div>
                {bounty.submissions.length ? (
                  <div className="bounty-submissions">
                    {bounty.submissions.map((submission) => (
                      <div className="bounty-submission" key={submission.id}>
                        <span className="mono">{truncateAddress(submission.wallet, 8, 4)}</span>
                        <a href={submission.url} target="_blank" rel="noreferrer" className="text-link">
                          Evidence <ExternalLink size={10} />
                        </a>
                        {isOwner && bounty.status !== "paid" ? (
                          <Button
                            size="xs"
                            variant="secondary"
                            onClick={() => approveMutation.mutate({ bounty, submission })}
                            loading={approveMutation.isPending}
                          >
                            Approve
                          </Button>
                        ) : submission.selected ? <Badge tone="green">Paid</Badge> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="bounty-actions">
                  <span className="mono">{bounty.claimantName ? `CLAIMANT ${bounty.claimantName}` : "OPEN FOR WORK"}</span>
                  {bounty.status === "open" || bounty.status === "review" ? (
                    <Button
                      size="xs"
                      variant={hasSubmitted ? "ghost" : "secondary"}
                      onClick={() => {
                        if (!user) return openAuth();
                        setSubmissionFor(bounty);
                      }}
                      disabled={hasSubmitted || isOwner}
                    >
                      {hasSubmitted ? "Submitted" : "Submit work"} <ArrowUpRight size={11} />
                    </Button>
                  ) : <Badge tone="green">Settled</Badge>}
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title="No open bounties"
          body="The verified developer can escrow token bounties for bugs, features or docs."
          icon={<GitPullRequest size={22} />}
        />
      )}

      {submissionFor ? (
        <div className="inline-modal">
          <div className="inline-modal-head">
            <strong>Submit to “{submissionFor.title}”</strong>
            <button onClick={() => setSubmissionFor(null)}><X size={14} /></button>
          </div>
          <label className="field">
            <span>Evidence URL</span>
            <input value={submissionUrl} onChange={(e) => setSubmissionUrl(e.target.value)} placeholder="https://github.com/…/pull/123" />
          </label>
          <label className="field">
            <span>Note for the maintainer</span>
            <textarea value={submissionNote} onChange={(e) => setSubmissionNote(e.target.value)} rows={2} />
          </label>
          <div className="form-actions">
            <Button variant="ghost" size="sm" onClick={() => setSubmissionFor(null)}>Cancel</Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => submitMutation.mutate(submissionFor)}
              loading={submitMutation.isPending}
              disabled={!submissionUrl.trim()}
            >
              Send submission
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function VotesTab({
  token,
  proposals,
  loading,
}: {
  token: TokenDetail;
  proposals: Proposal[];
  loading?: boolean;
}) {
  const { user, openAuth } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<"pr" | "issue" | "feature">("pr");
  const eligible =
    Boolean(user) &&
    token.tier !== "seed" &&
    (token.myHolding?.amountMicro ?? 0) >= token.community.vipThresholdMicro;

  const createMutation = useMutation({
    mutationFn: () =>
      api<Proposal>(`/api/tokens/${token.id}/proposals`, {
        method: "POST",
        body: { title, url, kind },
      }),
    onSuccess: () => {
      setShowCreate(false);
      setTitle("");
      setUrl("");
      queryClient.invalidateQueries({ queryKey: ["proposals", token.id] });
      notify("Proposal opened for token-holder vote.", { kind: "success" });
    },
    onError: (error) => notify(error instanceof ApiRequestError ? error.message : "Could not open proposal.", { kind: "error" }),
  });

  const voteMutation = useMutation({
    mutationFn: ({ proposal, choice }: { proposal: Proposal; choice: "yes" | "no" }) =>
      api<Proposal>(`/api/proposals/${proposal.id}/vote`, {
        method: "POST",
        body: { choice },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["proposals", token.id] });
      notify("Vote recorded with your full holding weight.", { kind: "success" });
    },
    onError: (error) => notify(error instanceof ApiRequestError ? error.message : "Vote failed.", { kind: "error" }),
  });

  if (token.tier === "seed") {
    return (
      <EmptyState
        title="Governance unlocks at Rising"
        body="Rising and Viral repos give holders a vote on PRs, issues and roadmap features."
        icon={<Trophy size={22} />}
      />
    );
  }

  return (
    <div className="votes-tab">
      <div className="votes-head">
        <div>
          <span className="eyebrow">Holder governance</span>
          <h3>Point the repo at what matters.</h3>
          <p>One wallet, one vote. Weight equals your live ${token.ticker} holding.</p>
        </div>
        {eligible ? (
          <Button size="sm" variant="primary" onClick={() => setShowCreate(true)} icon={<Plus size={13} />}>
            New proposal
          </Button>
        ) : !user ? (
          <Button size="sm" variant="secondary" onClick={openAuth}>Connect to vote</Button>
        ) : (
          <span className="vote-eligibility mono">
            <LockKeyhole size={11} /> {formatTokens(token.community.vipThresholdMicro, { compact: true })} ${token.ticker} to vote
          </span>
        )}
      </div>

      {showCreate ? (
        <Card className="proposal-form">
          <label className="field"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Prioritize the new renderer" /></label>
          <label className="field"><span>GitHub PR / issue / discussion</span><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo/issues/…" /></label>
          <div className="segmented">
            {(["pr", "issue", "feature"] as const).map((option) => (
              <button key={option} className={kind === option ? "active" : ""} onClick={() => setKind(option)}>
                {option === "pr" ? "Pull request" : option === "issue" ? "Issue" : "Feature"}
              </button>
            ))}
          </div>
          <div className="form-actions">
            <Button size="sm" variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={() => createMutation.mutate()} loading={createMutation.isPending} disabled={!title.trim() || !url.trim()}>Open vote</Button>
          </div>
        </Card>
      ) : null}

      {loading ? (
        <Skeleton style={{ height: 220 }} />
      ) : proposals.length ? (
        <div className="proposal-list">
          {proposals.map((proposal) => {
            const yes = proposal.votesYesMicro;
            const no = proposal.votesNoMicro;
            const total = yes + no;
            const yesPct = total ? (yes / total) * 100 : 50;
            const isClosed = proposal.status !== "open";
            return (
              <Card className="proposal-card" key={proposal.id}>
                <div className="proposal-top">
                  <div>
                    <div className="proposal-kind-row">
                      <Badge tone="outline">{proposal.kind.toUpperCase()}</Badge>
                      <span className={`proposal-status proposal-status-${proposal.status}`}>{proposal.status}</span>
                      <span className="mono proposal-date">closes {new Date(proposal.closesAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                    </div>
                    <h4>{proposal.title}</h4>
                    <a href={proposal.url} target="_blank" rel="noreferrer" className="text-link">
                      Open on GitHub <ExternalLink size={11} />
                    </a>
                  </div>
                  <span className="proposal-creator mono">BY {truncateAddress(proposal.creatorAddress, 7, 4)}</span>
                </div>
                <div className="vote-bars">
                  <div className="vote-bar-labels mono">
                    <span className="text-positive">YES {formatPercent(total ? (yes / total) * 10_000 : 0)}</span>
                    <span className="text-negative">NO {formatPercent(total ? (no / total) * 10_000 : 0)}</span>
                  </div>
                  <div className="vote-bar-track">
                    <div className="vote-bar-yes" style={{ width: `${yesPct}%` }} />
                    <div className="vote-bar-no" style={{ width: `${100 - yesPct}%` }} />
                  </div>
                  <div className="vote-bar-total mono">
                    <span>{formatTokens(total, { compact: true })} {token.ticker} voting</span>
                    <span>{proposal.myVote ? `YOUR VOTE: ${proposal.myVote.toUpperCase()}` : "NOT VOTED"}</span>
                  </div>
                </div>
                {!isClosed ? (
                  <div className="vote-actions">
                    <Button
                      size="xs"
                      variant={proposal.myVote === "yes" ? "primary" : "secondary"}
                      onClick={() => {
                        if (!user) return openAuth();
                        voteMutation.mutate({ proposal, choice: "yes" });
                      }}
                      disabled={!eligible || proposal.myVote !== null || voteMutation.isPending}
                      icon={<ThumbsUp size={12} />}
                    >
                      {proposal.myVote === "yes" ? "Voted yes" : "Vote yes"}
                    </Button>
                    <Button
                      size="xs"
                      variant={proposal.myVote === "no" ? "danger" : "ghost"}
                      onClick={() => {
                        if (!user) return openAuth();
                        voteMutation.mutate({ proposal, choice: "no" });
                      }}
                      disabled={!eligible || proposal.myVote !== null || voteMutation.isPending}
                      icon={<ThumbsDown size={12} />}
                    >
                      {proposal.myVote === "no" ? "Voted no" : "Vote no"}
                    </Button>
                    <span className="vote-note mono">WEIGHT = CURRENT HOLDING</span>
                  </div>
                ) : <div className="vote-result"><Badge tone={proposal.status === "passed" ? "green" : "neutral"}>{proposal.status === "passed" ? "Passed" : "Closed"}</Badge></div>}
              </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title="No proposals open"
          body="Token holders can put real PRs, issues and feature decisions to a weighted vote."
          icon={<GitPullRequest size={22} />}
        />
      )}
    </div>
  );
}
