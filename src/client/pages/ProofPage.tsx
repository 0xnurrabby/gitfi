import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BadgeCheck,
  Binary,
  Boxes,
  Check,
  CircleCheck,
  Code2,
  ExternalLink,
  FileCode2,
  Fingerprint,
  GitBranch,
  KeyRound,
  Layers,
  LockKeyhole,
  ShieldCheck,
  ShieldHalf,
  Terminal,
  X,
} from "lucide-react";
import clsx from "clsx";
import { api } from "../lib/api.js";
import { formatTimeAgo, truncateAddress } from "../../shared/format.js";
import { useAuth } from "../contexts/AuthContext.js";
import { Card, CopyButton, EmptyState, Skeleton } from "../components/ui.js";
import type { ChainStatusInfo } from "../../shared/types.js";

interface LedgerResponse {
  oraclePublicKey: string;
  verification: {
    valid: boolean;
    receipts: number;
    head: string | null;
    brokenAt: string | null;
  };
  receipts: Array<{
    seq: number;
    id: string;
    type: string;
    aggregate: string;
    digest: string;
    createdAt: string;
  }>;
}

const SECURITY_LAYERS = [
  {
    icon: <Fingerprint size={18} />,
    title: "Wallet signature first",
    copy: "Every session begins with an Ed25519 challenge. No bearer tokens, no GitHub OAuth scope.",
  },
  {
    icon: <FileCode2 size={18} />,
    title: "README proof, raw source",
    copy: "Ownership lines are fetched from raw.githubusercontent.com with cache-busting and server-bound nonces.",
  },
  {
    icon: <KeyRound size={18} />,
    title: "Oracle-signed mints",
    copy: "Repo NFTs are minted only after a backend signature over repo, wallet, challenge and metadata URI.",
  },
  {
    icon: <Boxes size={18} />,
    title: "Per-repo accounting",
    copy: "Developer fees, staking reward pools, sell reserves and bounty escrow are isolated per market, never pooled.",
  },
  {
    icon: <ShieldHalf size={18} />,
    title: "Pull-based fees",
    copy: "Failed claims can never block a trade. Royalties and yield wait in a claimable ledger.",
  },
  {
    icon: <Binary size={18} />,
    title: "Checked integer math",
    copy: "Bonding curves, fees and market caps use BigInt numerator/denominator math with explicit rounding.",
  },
];

export function ProofPage() {
  const { platform } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ["ledger"],
    queryFn: () => api<LedgerResponse>("/api/ledger"),
    staleTime: 10_000,
  });
  const { data: chain } = useQuery({
    queryKey: ["chain"],
    queryFn: () => api<ChainStatusInfo>("/api/chain"),
    refetchInterval: 15_000,
    staleTime: 8_000,
  });

  return (
    <div className="page proof-page">
      <div className="proof-hero">
        <div>
          <div className="eyebrow"><ShieldCheck size={12} /> Trust surface</div>
          <h1 className="page-title">Don’t trust the numbers.<br /><em>Verify the ledger.</em></h1>
          <p>
            GitFi’s application ledger is a signed hash chain. Mints, trades, claims, star burns and
            ownership transfers all produce verifiable receipts.
          </p>
          <div className="proof-hero-actions">
            <a href="/api/health" target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm">
              <Terminal size={13} /> API health <ExternalLink size={11} />
            </a>
            <span className="mono proof-live"><span className="signal-dot" /> oracle online</span>
          </div>
        </div>
        <div className="chain-visual">
          <div className="chain-top">
            <span className="mono">GITFI / APPCHAIN</span>
            {isLoading ? <Skeleton style={{ width: 84, height: 20 }} /> : (
              <span className={clsx("chain-valid-badge", data?.verification.valid ? "valid" : "invalid")}>
                {data?.verification.valid ? <Check size={11} /> : <X size={11} />}
                {data?.verification.valid ? "VERIFIED" : "BROKEN"}
              </span>
            )}
          </div>
          <div className="chain-blocks">
            {isLoading ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} style={{ height: 48 }} />) : (
              [...Array(5)].map((_, index) => (
                <div className="chain-block" key={index}>
                  <span className="mono">BLOCK {String((data?.verification.receipts ?? 0) - index).padStart(5, "0")}</span>
                  <div className="chain-hash" />
                  <span className="chain-link mono">{index < 4 ? "HASH LINK" : "HEAD"}</span>
                </div>
              ))
            )}
          </div>
          <div className="chain-head mono">
            <span>HEAD DIGEST</span>
            <span>{data?.verification.head?.slice(0, 26) ?? "—"}…</span>
          </div>
        </div>
      </div>

      <div className="proof-status-grid">
        <Card className="proof-status-card">
          <span className="metric-label">CHAIN INTEGRITY</span>
          <strong className={clsx("proof-status value", data?.verification.valid ? "text-positive" : "text-negative")}>
            {isLoading ? "…" : data?.verification.valid ? "SECURE" : "FAILED"}
          </strong>
          <span className="metric-sub">Ed25519 + SHA-256 hash chain</span>
        </Card>
        <Card className="proof-status-card">
          <span className="metric-label">SIGNED RECEIPTS</span>
          <strong className="proof-status value mono">{data?.verification.receipts ?? "—"}</strong>
          <span className="metric-sub">every state mutation is auditable</span>
        </Card>
        <Card className="proof-status-card proof-oracle-card">
          <span className="metric-label">ORACLE PUBLIC KEY</span>
          <div className="oracle-key mono">{data?.oraclePublicKey ?? "—"}</div>
          {data ? <CopyButton text={data.oraclePublicKey} label="Copy key" /> : null}
          <span className="metric-sub">verify mints independently</span>
        </Card>
        <Card className="proof-status-card">
          <span className="metric-label">NEAR {chain?.network?.toUpperCase() ?? "TESTNET"}</span>
          <strong className={clsx("proof-status value", chain?.ready ? "text-positive" : "")}>
            {chain?.ready ? "LIVE" : "SYNCING"}
          </strong>
          <span className="metric-sub">
            {chain?.contractId ?? platform?.contractId ?? "gitfi-395012.testnet"} · {chain?.totalDeeds ?? 0} deeds · {chain?.balanceNear ?? "—"} NEAR
          </span>
        </Card>
      </div>

      <Card className="receipts-card" style={{ marginBottom: 24 }}>
        <div className="side-card-head">
          <span className="eyebrow"><Boxes size={12} /> NEAR testnet anchors</span>
          <a className="mono text-link" href={chain?.contractUrl ?? platform?.contractUrl} target="_blank" rel="noreferrer">
            {chain?.contractId ?? platform?.contractId} <ExternalLink size={11} />
          </a>
        </div>
        <div className="receipt-list">
          <div className="receipt-head mono"><span>STATUS</span><span>EVENT</span><span>AGGREGATE</span><span>TX</span><span>WHEN</span></div>
          {chain?.txs.length ? (
            chain.txs.map((tx) => (
              <div className="receipt-row" key={tx.id}>
                <span className={clsx("mono", tx.status === "confirmed" ? "text-positive" : tx.status === "failed" ? "text-negative" : "muted")}>
                  {tx.status}
                </span>
                <span className="mono receipt-type">{tx.kind}</span>
                <span className="mono muted">{tx.aggregate.length > 24 ? `${tx.aggregate.slice(0, 22)}…` : tx.aggregate}</span>
                <span className="mono receipt-digest">
                  {tx.explorerUrl ? (
                    <a href={tx.explorerUrl} target="_blank" rel="noreferrer" className="text-link">
                      {tx.txHash?.slice(0, 16)}… <ExternalLink size={10} />
                    </a>
                  ) : (
                    "pending"
                  )}
                </span>
                <span className="mono muted">{formatTimeAgo(tx.createdAt)}</span>
              </div>
            ))
          ) : (
            <div className="receipt-row"><span className="mono muted">Waiting for the first testnet anchor…</span></div>
          )}
        </div>
      </Card>

      <div className="proof-layout">
        <Card className="receipts-card">
          <div className="side-card-head">
            <span className="eyebrow">Recent receipts</span>
            <span className="mono">NEWEST FIRST</span>
          </div>
          {isLoading ? (
            <div className="receipt-list">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} style={{ height: 46 }} />)}</div>
          ) : data?.receipts.length ? (
            <div className="receipt-list">
              <div className="receipt-head mono"><span>SEQ</span><span>EVENT</span><span>AGGREGATE</span><span>DIGEST</span><span>WHEN</span></div>
              {data.receipts.map((receipt) => (
                <div className="receipt-row" key={receipt.id}>
                  <span className="mono">{String(receipt.seq).padStart(4, "0")}</span>
                  <span className="mono receipt-type">{receipt.type}</span>
                  <span className="mono muted">{receipt.aggregate.length > 24 ? `${receipt.aggregate.slice(0, 22)}…` : receipt.aggregate}</span>
                  <span className="mono receipt-digest">{receipt.digest.slice(0, 18)}…</span>
                  <span className="mono muted">{formatTimeAgo(receipt.createdAt)}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No receipts yet" body="The ledger will populate as markets launch." icon={<Layers size={22} />} />
          )}
        </Card>

        <div className="proof-side">
          <Card className="proof-model-card">
            <span className="eyebrow">The verification pipeline</span>
            <div className="proof-pipeline">
              <div><span className="mono">01</span><strong>Public repo</strong><em>GitHub metadata + raw README</em></div>
              <div className="pipeline-line" />
              <div><span className="mono">02</span><strong>Sync line</strong><em>bound wallet · repo · nonce</em></div>
              <div className="pipeline-line" />
              <div><span className="mono">03</span><strong>Oracle signature</strong><em>Ed25519 over the deed payload</em></div>
              <div className="pipeline-line" />
              <div><span className="mono">04</span><strong>Repo NFT + token</strong><em>one deed, one market, isolated vault</em></div>
            </div>
          </Card>
          <Card className="contracts-card">
            <div className="side-card-head"><span className="eyebrow">Contract surface</span><GitBranch size={13} /></div>
            <a className="contract-row text-link" href={chain?.contractUrl ?? platform?.contractUrl} target="_blank" rel="noreferrer">
              <Code2 size={13} /><span>{chain?.contractId ?? platform?.contractId ?? "gitfi-395012.testnet"}</span><BadgeCheck size={12} />
            </a>
            <div className="contract-row"><Code2 size={13} /><span>repo_registry · NEP-171 deed</span><BadgeCheck size={12} /></div>
            <div className="contract-row"><Code2 size={13} /><span>oracle envelope · Ed25519</span><BadgeCheck size={12} /></div>
            <div className="contract-row"><Code2 size={13} /><span>receipt anchors · Borsh + nonce</span><BadgeCheck size={12} /></div>
            <p className="contracts-note">
              The Repo Registry and the GitFi Market are deployed on NEAR testnet. Deeds, balances,
              trades, staking rewards and bounties settle in real transactions; USD values use a live
              NEAR/USD quote.
            </p>
          </Card>
        </div>
      </div>

      <div className="security-section">
        <div className="security-head">
          <div>
            <div className="eyebrow">Security model</div>
            <h2>Fewer trust assumptions.<br /><em>More verifiable surface.</em></h2>
          </div>
        </div>
        <div className="security-grid">
          {SECURITY_LAYERS.map((layer) => (
            <div className="security-card" key={layer.title}>
              <span className="security-icon">{layer.icon}</span>
              <h3>{layer.title}</h3>
              <p>{layer.copy}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="proof-cta">
        <div>
          <span className="eyebrow">Builder-grade trust</span>
          <h2>Launch without surrendering your GitHub.</h2>
        </div>
        <Link to="/launch" className="btn btn-primary btn-md">Launch a repository <ArrowRight size={14} /></Link>
      </div>
    </div>
  );
}
