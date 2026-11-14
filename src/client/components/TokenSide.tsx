import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BadgeCheck,
  Camera,
  CheckCircle2,
  CircleDollarSign,
  Code2,
  ExternalLink,
  FileJson,
  GitFork,
  GitPullRequest,
  Github,
  Landmark,
  ShieldCheck,
  Sparkles,
  Star,
  Upload,
} from "lucide-react";
import type { TokenDetail, UserProfile } from "../../shared/types.js";
import { api, ApiRequestError } from "../lib/api.js";
import { formatPercent, formatTokens, formatUsd, shortNumber, truncateAddress } from "../../shared/format.js";
import { fileToLogoDataUrl } from "../lib/image.js";
import { useAuth } from "../contexts/AuthContext.js";
import { useToast } from "../contexts/ToastContext.js";
import { AssetLogo } from "./AssetLogo.js";
import { Button, Card, CopyButton } from "./ui.js";

export function RepoSignalCard({ token }: { token: TokenDetail }) {
  const health = token.stars.healthScore;
  const healthTone = health >= 75 ? "positive" : health >= 50 ? "warn" : "negative";
  return (
    <Card className="signal-card">
      <div className="side-card-head">
        <span className="eyebrow"><Github size={12} /> Repo signal</span>
        <a
          href={`https://github.com/${token.repo.fullName}`}
          target="_blank"
          rel="noreferrer"
          className="icon-link"
          aria-label="Open GitHub repository"
        >
          <ExternalLink size={13} />
        </a>
      </div>
      <div className="signal-health">
        <div
          className={`health-ring health-${healthTone}`}
          style={{ background: `conic-gradient(var(--${healthTone === "positive" ? "positive" : healthTone === "warn" ? "amber" : "negative"}) ${health * 3.6}deg, var(--line-soft) 0deg)` }}
        >
          <span>{health}</span>
        </div>
        <div>
          <strong>Repo health</strong>
          <p>
            {health >= 75
              ? "Active, organic and commit-backed."
              : health >= 50
                ? "Healthy, with some signals to watch."
                : "Low activity or unusual star ratio."}
          </p>
        </div>
      </div>
      <div className="signal-grid">
        <div>
          <span className="mono">STARS</span>
          <strong><Star size={12} /> {shortNumber(token.stars.current)}</strong>
          <em className="text-positive">+{token.stars.velocity1h}/h</em>
        </div>
        <div>
          <span className="mono">FORKS</span>
          <strong><GitFork size={12} /> {shortNumber(token.repo.forks)}</strong>
          <em>{((token.repo.forks / Math.max(1, token.stars.current)) * 100).toFixed(1)}% ratio</em>
        </div>
        <div>
          <span className="mono">COMMITS</span>
          <strong><Code2 size={12} /> {shortNumber(token.repo.commitCount)}</strong>
          <em>{token.repo.license ?? "no license"}</em>
        </div>
        <div>
          <span className="mono">ISSUES</span>
          <strong><GitPullRequest size={12} /> {shortNumber(token.repo.openIssues)}</strong>
          <em>{token.repo.language ?? "polyglot"}</em>
        </div>
      </div>
      {token.stars.milestones.length ? (
        <div className="milestone-list">
          <span className="milestone-label mono"><Sparkles size={11} /> STAR MILESTONES</span>
          {token.stars.milestones.slice(0, 3).map((milestone) => (
            <div className="milestone-row mono" key={milestone.id}>
              <span>★ {milestone.stars.toLocaleString()}</span>
              <span>{milestone.burnedMicro ? `${formatTokens(milestone.burnedMicro, { compact: true })} burned` : "baseline"}</span>
              <span>{new Date(milestone.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="signal-proof">
        <ShieldCheck size={12} />
        <span>README ownership proof cached</span>
        <CheckCircle2 size={12} />
      </div>
    </Card>
  );
}

export function DeveloperCard({
  token,
  onClaim,
}: {
  token: TokenDetail;
  onClaim: () => void;
}) {
  const { user, openAuth, setUser } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const isOwner = Boolean(user && token.ownerAddress === user.address);
  const frozen = token.royaltyFrozen;

  const logoMutation = useMutation({
    mutationFn: async (file: File) => {
      const dataUrl = await fileToLogoDataUrl(file);
      return api<{ token: TokenDetail }>(`/api/tokens/${token.id}/logo`, {
        method: "POST",
        body: { dataUrl },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["token"] });
      queryClient.invalidateQueries({ queryKey: ["home"] });
      notify("Logo updated and pushed to token metadata.", { kind: "success" });
      setUploading(false);
    },
    onError: (error) => {
      notify(error instanceof ApiRequestError ? error.message : "Logo update failed.", {
        kind: "error",
      });
      setUploading(false);
    },
  });

  const claimMutation = useMutation({
    mutationFn: () => api<{ amountMicro: number; user: UserProfile }>("/api/claim", { method: "POST" }),
    onSuccess: (result) => {
      if (result.user) setUser(result.user);
      queryClient.invalidateQueries({ queryKey: ["token"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      notify(`Claimed ${formatUsd(result.amountMicro)} to USDC.`, {
        kind: "success",
        title: "Royalties claimed",
      });
    },
    onError: (error) =>
      notify(error instanceof ApiRequestError ? error.message : "Nothing to claim yet.", { kind: "error" }),
  });

  return (
    <Card className="developer-card">
      <div className="side-card-head">
        <span className="eyebrow"><CircleDollarSign size={12} /> Developer vault</span>
        <span className={`mono side-badge ${frozen ? "text-negative" : ""}`}>
          {frozen ? "FROZEN" : token.ownerAddress ? "0.5% LIVE" : "UNCLAIMED"}
        </span>
      </div>
      {token.ownerAddress ? (
        <div className="developer-identity">
          <span className="dev-avatar">{(token.ownerAddress.split(".")[0] ?? "D").slice(0, 2).toUpperCase()}</span>
          <div>
            <strong>{truncateAddress(token.ownerAddress, 11, 6)}</strong>
            <span><BadgeCheck size={11} /> Verified repo owner</span>
          </div>
          <CopyButton text={token.ownerAddress} label="" className="icon-copy" />
        </div>
      ) : (
        <div className="unclaimed-dev">
          <div className="unclaimed-icon"><Landmark size={18} /></div>
          <strong>{formatUsd(token.developer.unclaimedVaultMicro)}</strong>
          <span>waiting in the unclaimed developer vault</span>
          <p>
            This token was community-indexed. The real maintainer can prove ownership via README and
            claim the Repo NFT plus every accrued fee.
          </p>
          <Button
            size="sm"
            variant="primary"
            className="full-width"
            onClick={() => (user ? onClaim() : openAuth())}
          >
            <ShieldCheck size={13} /> {user ? "Claim this repository" : "Connect to claim"}
          </Button>
        </div>
      )}

      <div className="developer-numbers">
        <div>
          <span>CLAIMABLE ROYALTIES</span>
          <strong className="mono">{formatUsd(token.developer.claimableMicro)}</strong>
        </div>
        <div>
          <span>UNCLAIMED VAULT</span>
          <strong className="mono">{formatUsd(token.developer.unclaimedVaultMicro)}</strong>
        </div>
        <div>
          <span>VESTING ON DEV BUYS</span>
          <strong className="mono">{token.developer.vestingDays} days</strong>
        </div>
      </div>

      {isOwner ? (
        <div className="owner-tools">
          <div className="owner-tool-row">
            <div>
              <strong>Logo & metadata</strong>
              <span>Edge-cached + on-chain JSON</span>
            </div>
            <Button
              size="xs"
              variant="secondary"
              onClick={() => fileRef.current?.click()}
              loading={uploading || logoMutation.isPending}
              icon={<Camera size={12} />}
            >
              Update
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setUploading(true);
                logoMutation.mutate(file);
                event.target.value = "";
              }}
            />
          </div>
          <div className="owner-tool-row">
            <div>
              <strong>Claimable royalties</strong>
              <span>{formatUsd(token.developer.claimableMicro)} ready to withdraw</span>
            </div>
            <Button
              size="xs"
              variant="primary"
              onClick={() => claimMutation.mutate()}
              loading={claimMutation.isPending}
              disabled={token.developer.claimableMicro <= 0 || frozen}
            >
              Claim
            </Button>
          </div>
          <a
            href={`/api/metadata/${token.id}.json`}
            target="_blank"
            rel="noreferrer"
            className="owner-tool-row owner-tool-link"
          >
            <div>
              <strong>Token metadata</strong>
              <span>Wallet + DEX discovery JSON</span>
            </div>
            <ExternalLink size={13} />
          </a>
        </div>
      ) : null}

      {frozen ? (
        <div className="developer-frozen">
          GitHub no longer returns this repository. Royalties are frozen until it is public again.
        </div>
      ) : null}
    </Card>
  );
}

export function NftCard({ token }: { token: TokenDetail }) {
  if (!token.nft) return null;
  return (
    <Card className="nft-card">
      <div className="side-card-head">
        <span className="eyebrow"><FileJson size={12} /> Repo deed NFT</span>
        <span className="mono side-badge">{token.nft.status.toUpperCase()}</span>
      </div>
      <div className="nft-visual">
        <AssetLogo src={token.logoUrl} ticker={token.ticker} size={58} />
        <div>
          <span className="mono nft-label">GITFI REPO NFT</span>
          <strong>{token.repo.fullName}</strong>
          <span className="mono nft-id">{token.id}</span>
        </div>
        <div className="nft-seal"><BadgeCheck size={17} /></div>
      </div>
      <div className="nft-meta">
        <span>DEED STATUS</span>
        <strong>{token.nft.escrowed ? "Escrowed for owner claim" : "Staked in protocol vault"}</strong>
        <span>ORACLE TX</span>
        {token.nft.chainTxHash && token.nft.chainExplorerUrl ? (
          <a
            className="mono nft-tx text-link"
            href={token.nft.chainExplorerUrl}
            target="_blank"
            rel="noreferrer"
          >
            {token.nft.chainTxHash.slice(0, 20)}… <ExternalLink size={10} />
          </a>
        ) : (
          <span className="mono nft-tx">{token.nft.txHash.slice(0, 24)}…</span>
        )}
      </div>
      <div className="nft-actions">
        <a href={`/api/nft/${token.id}/metadata`} target="_blank" rel="noreferrer" className="text-link">
          <FileJson size={11} /> Metadata JSON
        </a>
        <CopyButton
          text={token.nft.chainTxHash ?? token.nft.txHash}
          label={token.nft.chainTxHash ? "NEAR tx" : "TX hash"}
        />
      </div>
      <div className="nft-note">
        {token.nft.chainTxHash ? (
          <>
            <BadgeCheck size={12} />
            <span>
              Repo Deed NFT minted on NEAR {token.nft.chainStatus === "confirmed" ? "testnet" : "testnet (pending)"}.
              Bound to verified repository ownership; only one deed can exist per repo.
            </span>
          </>
        ) : (
          <>
            <BadgeCheck size={12} />
            <span>
              Oracle-signed deed recorded locally. The Repo Deed NFT is queued for NEAR testnet and cannot be duplicated.
            </span>
          </>
        )}
      </div>
    </Card>
  );
}
