import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  CircleAlert,
  Clock3,
  Coins,
  Copy,
  ExternalLink,
  FileCode2,
  Github,
  GitPullRequest,
  ImagePlus,
  KeyRound,
  Loader2,
  LockKeyhole,
  Rocket,
  ShieldCheck,
  Sparkles,
  Star,
  Upload,
  Wallet,
  X,
} from "lucide-react";
import clsx from "clsx";
import { TIERS, tierForStars } from "../../shared/economics.js";
import type { TokenSummary, UserProfile, VerificationChallenge, VerifyResult } from "../../shared/types.js";
import { api, ApiRequestError } from "../lib/api.js";
import { fileToLogoDataUrl } from "../lib/image.js";
import {
  formatPercent,
  formatTokens,
  formatUsd,
  shortNumber,
  truncateAddress,
} from "../../shared/format.js";
import { useAuth } from "../contexts/AuthContext.js";
import { useToast } from "../contexts/ToastContext.js";
import { AssetLogo } from "../components/AssetLogo.js";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  Countdown,
  ProgressBar,
  buttonClass,
} from "../components/ui.js";
import { TierBadge as TierBadgeLocal } from "../components/Market.js";

type Stage = "source" | "proof" | "metadata";

interface RepoPreview {
  repo: {
    fullName: string;
    description: string | null;
    stars: number;
    forks: number;
    language: string | null;
    topics: string[];
    license: string | null;
    healthScore: number;
    commitCount: number;
    pushedAt: string | null;
    createdAtGithub: string | null;
    defaultBranch: string;
    readmePresent: boolean;
  };
  summary: string[];
  existingToken: { id: string; slug: string; name: string; ticker: string; owner_wallet: string | null } | null;
  indexed: boolean;
}

const SUGGESTIONS = ["karpathy/micrograd", "astral-sh/ruff", "honojs/hono", "openai/whisper"];

export function LaunchPage() {
  const { user, openAuth, nearWallet, platform } = useAuth();
  const { notify } = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [stage, setStage] = useState<Stage>("source");
  const [repoInput, setRepoInput] = useState(params.get("repo") ?? "");
  const [preview, setPreview] = useState<RepoPreview | null>(null);
  const [verifiedRepo, setVerifiedRepo] = useState<VerifyResult | null>(null);
  const [challenge, setChallenge] = useState<VerificationChallenge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);

  const [name, setName] = useState("");
  const [ticker, setTicker] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const repoSummary = verifiedRepo?.repo ?? preview?.repo ?? null;
  const tier = repoSummary ? tierForStars(repoSummary.stars) : null;
  const tierConfig = tier ? TIERS[tier] : null;
  const existing = verifiedRepo?.token ?? preview?.existingToken ?? null;
  const existingOwner = existing
    ? "ownerAddress" in existing
      ? existing.ownerAddress
      : existing.owner_wallet
    : null;

  useEffect(() => {
    if (!repoSummary) return;
    const repoName = repoSummary.fullName.split("/")[1] ?? "repo";
    const derivedTicker = repoName.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 10) || "REPO";
    if (!ticker) setTicker(derivedTicker);
    if (!name) {
      const title = repoName.replace(/[-_]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
      setName(title.slice(0, 48));
    }
    if (!description) {
      const base = repoSummary.description ?? `A public repository token for ${repoSummary.fullName}.`;
      setDescription(
        (base.length >= 24
          ? base
          : `${base} Verified public code, priced and funded by its community on GitFi.`).slice(0, 600),
      );
    }
  }, [repoSummary, preview, name, ticker, description]);

  const reset = () => {
    setChallenge(null);
    setPreview(null);
    setVerifiedRepo(null);
    setError(null);
    setErrorCode(null);
    setStage("source");
  };

  const challengeMutation = useMutation({
    mutationFn: () =>
      api<VerificationChallenge>("/api/repos/verify/challenge", {
        method: "POST",
        body: { repo: repoInput.trim() },
      }),
    onSuccess: (data) => {
      setChallenge(data);
      setStage("proof");
      setError(null);
      setErrorCode(null);
      api<RepoPreview>(`/api/github/repo?repo=${encodeURIComponent(data.repo)}`)
        .then((repo) => setPreview(repo))
        .catch(() => undefined);
    },
    onError: (caught) => {
      setError(caught instanceof ApiRequestError ? caught.message : "Could not create a proof challenge.");
      setErrorCode(caught instanceof ApiRequestError ? caught.code : null);
    },
  });

  const beginOwnerProof = async () => {
    setResuming(true);
    setError(null);
    setErrorCode(null);
    try {
      const resumed = await api<{ verified: boolean; result: VerifyResult | null }>(
        "/api/repos/verify/resume",
        { method: "POST", body: { repo: repoInput.trim() } },
      );
      if (resumed.verified && resumed.result) {
        setVerifiedRepo(resumed.result);
        setChallenge(null);
        if (resumed.result.token) {
          notify("This repository is already verified by your wallet.", {
            kind: "success",
            title: "Verification found",
          });
          navigate(`/real/${resumed.result.token.id}`);
          return;
        }
        setStage("metadata");
        notify("Verification already complete. Continue straight to market setup.", {
          kind: "success",
          title: "Already verified",
        });
        return;
      }
    } catch {
    } finally {
      setResuming(false);
    }
    challengeMutation.mutate();
  };

  const verifyMutation = useMutation({
    mutationFn: () =>
      api<VerifyResult>("/api/repos/verify", {
        method: "POST",
        body: { challengeId: challenge?.challengeId },
      }),
    onSuccess: (data) => {
      setVerifiedRepo(data);
      setChallenge(null);
      setError(null);
      setErrorCode(null);
      if (data.token) {
        notify(
          data.next === "claim"
            ? "Ownership verified — the Repo NFT and vault are yours."
            : "You already own this repository.",
          { kind: "success", title: "Repository verified" },
        );
        navigate(`/real/${data.token.id}`);
        return;
      }
      setStage("metadata");
      notify("README proof verified. Set up the market.", { kind: "success" });
    },
    onError: (caught) => {
      setError(caught instanceof ApiRequestError ? caught.message : "Verification failed.");
      setErrorCode(caught instanceof ApiRequestError ? caught.code : null);
    },
  });

  const launchMutation = useMutation({
    mutationFn: async () => {
      if (!user || !nearWallet) {
        throw new ApiRequestError(`Connect your NEAR ${platform?.network === "mainnet" ? "mainnet" : "testnet"} wallet to pay the launch fee.`, 401, "AUTH_REQUIRED");
      }
      const platformFeeAddress = platform?.platformFeeAddress;
      if (!platformFeeAddress) {
        throw new ApiRequestError("Platform fee address is not configured.", 500, "PLATFORM_FEE_ADDRESS_MISSING");
      }
      const fee = BigInt(platform?.launchFeeYocto ?? "1000000000000000000000000");
      const accounts = await nearWallet.getAccounts({
        network: platform?.network === "mainnet" ? "mainnet" : "testnet",
      });
      const signerId = accounts[0]?.accountId ?? user.address;
      const outcome = await nearWallet.signAndSendTransaction({
        receiverId: platformFeeAddress,
        signerId,
        actions: [{ type: "Transfer", params: { deposit: fee.toString() } }],
      });
      const txHash =
        outcome.transaction_outcome?.id ??
        (outcome.transaction as { hash?: string } | undefined)?.hash;
      if (!txHash) {
        throw new ApiRequestError(
          "Launch fee was sent, but the transaction hash was not returned. Check your wallet.",
          502,
          "PAYMENT_HASH_MISSING",
        );
      }
      return api<{ token: TokenSummary; receipt: string; nftId: string }>("/api/tokens", {
        method: "POST",
        body: {
          repo: repoSummary?.fullName,
          mode: "owner",
          name,
          ticker,
          description,
          website: website || undefined,
          twitter: twitter || undefined,
          logoDataUrl: logoDataUrl || undefined,
          paymentTxHash: txHash,
        },
      });
    },
    onSuccess: (data) => {
      notify(
        data.token.status === "prelaunch"
          ? `$${data.token.ticker} is live after a ${tierConfig?.countdownSeconds ?? 0}s anti-snipe countdown.`
          : `$${data.token.ticker} is live on the bonding curve.`,
        { kind: "success", title: "Market launched" },
      );
      navigate(`/real/${data.token.id}`);
    },
    onError: (caught) =>
      setError(caught instanceof ApiRequestError ? caught.message : "Launch failed."),
  });

  const onLogo = async (file: File) => {
    try {
      const dataUrl = await fileToLogoDataUrl(file);
      setLogoDataUrl(dataUrl);
      setLogoPreview(dataUrl);
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  const stepIndex = stage === "source" ? 0 : stage === "proof" ? 1 : 2;
  const canLaunch =
    Boolean(user) &&
    Boolean(nearWallet) &&
    Boolean(repoSummary) &&
    !existing &&
    name.trim().length >= 2 &&
    /^[A-Z0-9]{2,10}$/.test(ticker) &&
    description.trim().length >= 24 &&
    description.trim().length <= 600 &&
    !launchMutation.isPending;

  return (
    <div className="page launch-page">
      <div className="launch-head">
        <div>
          <div className="eyebrow">Underdog launchpad</div>
          <h1 className="page-title">
            Put your repo<br />
            <em>on the market.</em>
          </h1>
          <p>No liquidity required. No free allocation. Just public code and an open price.</p>
        </div>
        <div className="launch-head-side mono">
          <span><ShieldCheck size={12} /> PUBLIC REPOS ONLY</span>
          <span><BadgeCheck size={12} /> README PROOF</span>
          <span><LockKeyhole size={12} /> OWNER CAN CLAIM</span>
        </div>
      </div>

      <div className="launch-owner-only">
        <ShieldCheck size={16} />
        <div>
          <strong>Only the verified repository owner can create this token.</strong>
          <span>
            One repo → one token. Another wallet cannot launch a market from your repo;
            ownership is proven with the README sync line first. The 1 NEAR platform
            launch fee activates the market.
          </span>
        </div>
      </div>

      <div className="launch-progress">
        {["Source repository", "Prove ownership", "Market setup"].map(
          (label, index) => (
            <div
              className={clsx(
                "launch-progress-step",
                stepIndex >= index && "done",
                stepIndex === index && "active",
              )}
              key={label}
            >
              <span className="mono">{stepIndex > index ? "✓" : `0${index + 1}`}</span>
              <span>{label}</span>
              {index < 2 ? <span className="launch-progress-line" /> : null}
            </div>
          ),
        )}
      </div>

      <div className="launch-grid">
        <div className="launch-main">
          {!user ? (
            <Card className="launch-wallet-gate">
              <div className="launch-wallet-icon"><Wallet size={25} /></div>
              <span className="eyebrow">Step zero</span>
              <h2>Connect before you launch.</h2>
              <p>The Repo NFT is bound to a wallet, not a GitHub session. Connect a NEAR wallet to continue.</p>
              <Button variant="primary" onClick={openAuth} icon={<Wallet size={15} />}>Connect wallet</Button>
              <span className="mono">NO GITHUB OAUTH · ED25519 SIGNATURE</span>
            </Card>
          ) : stage === "source" ? (
            <Card className="launch-card">
              <div className="launch-card-head">
                <span className="launch-card-num mono">01</span>
                <div>
                  <h2>Where is the code?</h2>
                  <p>
                    Paste the public GitHub repo you control. GitFi checks the public metadata,
                    then asks for the README proof before any token or market can be created.
                  </p>
                </div>
              </div>
              <label className="repo-input-wrap">
                <Github size={18} />
                <input
                  value={repoInput}
                  onChange={(event) => setRepoInput(event.target.value)}
                  placeholder="owner/repository or github.com/owner/repository"
                  autoFocus
                  aria-label="GitHub repository"
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void beginOwnerProof()}
                  loading={challengeMutation.isPending || resuming}
                  disabled={repoInput.trim().length < 3}
                >
                  Generate proof <ArrowRight size={13} />
                </Button>
              </label>
              <div className="repo-suggestions">
                <span className="mono">TRY A PUBLIC REPO</span>
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} onClick={() => setRepoInput(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
              {error ? <div className="form-error"><CircleAlert size={13} />{error}</div> : null}
              {existing ? (
                <div className="existing-token-card">
                  <div className="existing-token-icon"><BadgeCheck size={18} /></div>
                  <div>
                    <strong>This repo already has a market.</strong>
                    <span className="mono">${existing.ticker} · {existingOwner ? "verified developer" : "unclaimed developer vault"}</span>
                  </div>
                  <Link to={`/real/${existing.id}`} className={buttonClass("secondary", "xs")}>View token <ArrowRight size={11} /></Link>
                </div>
              ) : null}
              <div className="launch-checks">
                <span><Check size={11} /> Public repo</span>
                <span><Check size={11} /> Non-fork</span>
                <span><Check size={11} /> Real commit history</span>
                <span><Check size={11} /> README present</span>
              </div>
            </Card>
          ) : stage === "proof" ? (
            <Card className="launch-card proof-card">
              <div className="launch-card-head">
                <span className="launch-card-num mono">02</span>
                <div>
                  <h2>Prove you own the repo.</h2>
                  <p>No GitHub login. Paste one server-bound line into the public README and commit it.</p>
                </div>
              </div>
              {preview ? (
                <div className="repo-preview">
                  <div className="repo-preview-head">
                    <div>
                      <span className="mono repo-preview-label">PUBLIC REPOSITORY</span>
                      <strong><Github size={15} /> {preview.repo.fullName}</strong>
                    </div>
                    <div className="repo-preview-stats mono">
                      <span><Star size={11} /> {shortNumber(preview.repo.stars)}</span>
                      <span>{shortNumber(preview.repo.forks)} forks</span>
                      <span>{shortNumber(preview.repo.commitCount)} commits</span>
                    </div>
                  </div>
                  <div className="repo-preview-flags">
                    <Badge tone="green"><Check size={10} /> public</Badge>
                    <Badge tone="green"><Check size={10} /> commits</Badge>
                    <Badge tone={preview.repo.readmePresent ? "green" : "red"}>{preview.repo.readmePresent ? "README found" : "README missing"}</Badge>
                  </div>
                </div>
              ) : null}
              {challenge ? (
                <>
                  <div className="proof-code-card">
                    <div className="proof-code-head">
                      <span><FileCode2 size={13} /> Paste anywhere in README.md</span>
                      <CopyButton text={challenge.line} label="Copy line" />
                    </div>
                    <code>{challenge.line}</code>
                    <div className="proof-code-foot mono">
                      <span><KeyRound size={11} /> Bound to {truncateAddress(user.address, 8, 4)}</span>
                      <Countdown to={challenge.expiresAt} prefix="expires" />
                      <button onClick={() => void beginOwnerProof()}>Regenerate</button>
                    </div>
                  </div>
                  <div className="proof-instructions">
                    <div><span className="mono">01</span><p>Open <code>README.md</code> in the default branch.</p></div>
                    <div><span className="mono">02</span><p>Paste the line and commit it publicly.</p></div>
                    <div><span className="mono">03</span><p>We check the raw file and GitHub's contents API. No OAuth.</p></div>
                  </div>
                  <div className="proof-links">
                    <a
                      href={`https://github.com/${challenge.repo}/blob/${preview?.repo.defaultBranch ?? "main"}/README.md`}
                      target="_blank"
                      rel="noreferrer"
                      className={buttonClass("secondary", "xs")}
                    >
                      <Github size={12} /> Open README on GitHub <ExternalLink size={10} />
                    </a>
                    <span className="mono">GitHub can take 10–30s to serve a fresh commit</span>
                  </div>
                  {error ? <div className="form-error"><CircleAlert size={13} />{error}</div> : null}
                  <Button
                    variant="primary"
                    size="lg"
                    className="full-width"
                    onClick={() => verifyMutation.mutate()}
                    loading={verifyMutation.isPending}
                    icon={<BadgeCheck size={15} />}
                  >
                    {errorCode === "CODE_NOT_FOUND" ? "Recheck GitHub — verify" : "I’ve committed the line — verify"}
                  </Button>
                  {errorCode === "CODE_NOT_FOUND" ? (
                    <p className="proof-retry-note">
                      The code is still valid. If you just committed, wait a few seconds and press recheck.
                    </p>
                  ) : null}
                </>
              ) : (
                <div className="proof-loading"><Loader2 className="spin" size={20} /><span>Preparing your proof…</span></div>
              )}
            </Card>
          ) : (
            <Card className="launch-card token-setup-card">
              <div className="launch-card-head">
                <span className="launch-card-num mono">03</span>
                <div>
                  <h2>Design the asset.</h2>
                  <p>Identity matters. Upload a clean logo, keep the name legible, and describe the utility in one breath.</p>
                </div>
                {tier ? <TierBadgeLocal tier={tier} /> : null}
              </div>
              {repoSummary ? (
                <div className="setup-repo-banner">
                  <Github size={14} />
                  <span className="mono">{repoSummary.fullName}</span>
                  <span className="mono"><Star size={11} /> {shortNumber(repoSummary.stars)}</span>
                  <a href={`https://github.com/${repoSummary.fullName}`} target="_blank" rel="noreferrer"><ExternalLink size={11} /></a>
                </div>
              ) : null}
              <div className="setup-layout">
                <div className="logo-uploader">
                  <div
                    className={clsx("logo-drop", logoPreview && "has-logo")}
                    onClick={() => fileRef.current?.click()}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      const file = event.dataTransfer.files?.[0];
                      if (file) void onLogo(file);
                    }}
                  >
                    {logoPreview ? (
                      <img src={logoPreview} alt="Token logo preview" />
                    ) : (
                      <>
                        <ImagePlus size={24} />
                        <span>Drop logo</span>
                        <em>512 × 512 · WebP compressed</em>
                      </>
                    )}
                  </div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void onLogo(file);
                    }}
                  />
                  <button className="text-button" onClick={() => fileRef.current?.click()}>Upload image</button>
                  <span className="mono logo-note">Instant edge cache + on-chain metadata</span>
                </div>
                <div className="setup-fields">
                  <div className="form-grid-2">
                    <label className="field">
                      <span>Token name</span>
                      <input value={name} onChange={(event) => setName(event.target.value.slice(0, 48))} placeholder="Create NEAR App" />
                      <em>{name.length}/48</em>
                    </label>
                    <label className="field field-ticker">
                      <span>Ticker</span>
                      <div className="ticker-input">
                        <span>$</span>
                        <input
                          value={ticker}
                          onChange={(event) => setTicker(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10))}
                          placeholder="NCA"
                        />
                      </div>
                      <em>{ticker.length}/10</em>
                    </label>
                  </div>
                  <label className="field">
                    <span>Description</span>
                    <textarea
                      value={description}
                      onChange={(event) => setDescription(event.target.value.slice(0, 600))}
                      rows={4}
                      placeholder="What does this public repo unlock for the people who use it?"
                    />
                    <em>{description.length}/600 · minimum 24</em>
                  </label>
                  <div className="form-grid-2">
                    <label className="field"><span>Website <small>optional</small></span><input value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="https://…" /></label>
                    <label className="field"><span>Social <small>optional</small></span><input value={twitter} onChange={(event) => setTwitter(event.target.value)} placeholder="https://x.com/…" /></label>
                  </div>
                </div>
              </div>

              <div className="launch-terms">
                <div className="launch-term">
                  <span className="mono">TIER</span>
                  <strong>{tierConfig?.label}</strong>
                  <em>Based on public GitHub stars</em>
                </div>
                <div className="launch-term">
                  <span className="mono">GRADUATION TARGET</span>
                  <strong>{tierConfig ? formatUsd(tierConfig.targetMarketCapMicro, { compact: true }) : "—"}</strong>
                  <em>100% investor-funded</em>
                </div>
                <div className="launch-term">
                  <span className="mono">WALLET CAP</span>
                  <strong>{tierConfig ? formatPercent(tierConfig.perWalletCapBps) : "—"}</strong>
                  <em>During bonding curve</em>
                </div>
                <div className="launch-term">
                  <span className="mono">COUNTDOWN</span>
                  <strong>{tierConfig ? `${tierConfig.countdownSeconds}s` : "—"}</strong>
                  <em>Anti-snipe window</em>
                </div>
              </div>

              <div className="launch-owner-only" style={{ marginTop: 12, marginBottom: 12 }}>
                <Wallet size={16} />
                <div>
                  <strong>Platform launch fee: 1 NEAR</strong>
                  <span>
                    Paid as a platform fee{" "}
                    <span className="mono">{platform?.platformFeeAddress ?? "configured by the platform"}</span>{" "}
                    before the market is created.
                  </span>
                </div>
              </div>

              <div className="owner-assurance">
                <ShieldCheck size={15} />
                <div>
                  <strong>You keep the Repo NFT and 0.5% forever.</strong>
                  <span>
                    No free token allocation means no rug vector for holders. Only your verified
                    wallet can create this market and claim developer royalties.
                  </span>
                </div>
              </div>

              {error ? <div className="form-error"><CircleAlert size={13} />{error}</div> : null}

              <Button
                size="lg"
                variant="primary"
                className="launch-submit full-width"
                disabled={!canLaunch}
                loading={launchMutation.isPending}
                onClick={() => launchMutation.mutate()}
                icon={<Rocket size={16} />}
              >
                Launch ${ticker || "TICKER"}
              </Button>
              <div className="launch-disclaimer mono">
                <LockKeyhole size={11} /> ONE REPO = ONE TOKEN = ONE REPO NFT · LAUNCH IS PERMANENT
              </div>
            </Card>
          )}
        </div>

        <aside className="launch-side">
          <Card className="launch-preview-card">
            <div className="side-card-head">
              <span className="eyebrow"><Sparkles size={12} /> Live preview</span>
              <span className="mono side-badge">DRAFT</span>
            </div>
            <div className="launch-preview-asset">
              <AssetLogo src={logoPreview} ticker={ticker || "GF"} size={54} />
              <div>
                <strong>${ticker || "TICKER"}</strong>
                <span>{name || "Your repository token"}</span>
                <em className="mono">{repoSummary?.fullName ?? "owner/repo"}</em>
              </div>
              {tier ? <TierBadgeLocal tier={tier} /> : null}
            </div>
            <p className="launch-preview-desc">
              {description || "The repo description becomes the first thing traders read. Make it precise."}
            </p>
            <div className="launch-preview-stats">
              <div><span>PRICE</span><strong className="mono">Curve open</strong></div>
              <div><span>SUPPLY</span><strong className="mono">1B fixed</strong></div>
              <div><span>CREATOR FEES</span><strong className="mono text-positive">0.50%</strong></div>
              <div><span>TRADE FEE</span><strong className="mono">1.30%</strong></div>
            </div>
            <div className="launch-curve-preview">
              <div className="launch-curve-labels mono"><span>BONDING CURVE</span><span>GRADUATED</span></div>
              <svg viewBox="0 0 300 64" className="launch-curve-svg" aria-hidden="true">
                <path d="M2 62 C 80 60, 175 52, 296 6" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
                <path d="M2 62 C 80 60, 175 52, 296 6 L296 64 L2 64 Z" fill="url(#launchGradient)" opacity=".2" />
                <defs>
                  <linearGradient id="launchGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="var(--accent)" />
                    <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <line x1="240" x2="240" y1="0" y2="64" stroke="var(--line)" strokeDasharray="3 4" />
                <circle cx="240" cy="22" r="3" fill="var(--accent)" />
              </svg>
              <span className="mono launch-curve-note">GRADUATION AT {tier === "seed" ? "20%" : tier === "rising" ? "16%" : "16%"} RAISE</span>
            </div>
          </Card>

          <Card className="launch-facts">
            <div className="side-card-head"><span className="eyebrow">The terms</span><GitPullRequest size={13} /></div>
            <div className="launch-fact"><span className="mono">01</span><div><strong>Zero free allocation</strong><p>Developers never receive tokens for free. Fair launch for every wallet, including yours.</p></div></div>
            <div className="launch-fact"><span className="mono">02</span><div><strong>0.5% creator + 0.3% platform</strong><p>Every trade pays the verified creator 0.5% and the platform 0.3%, claimable from the market contract.</p></div></div>
            <div className="launch-fact"><span className="mono">03</span><div><strong>Real staker yield</strong><p>0.5% of every trade is paid to token stakers in NEAR, directly by the market contract.</p></div></div>
            <div className="launch-fact"><span className="mono">04</span><div><strong>On-chain graduation</strong><p>At the curve target the curve closes; the market and reserve stay open on-chain. No fake DEX pool.</p></div></div>
          </Card>

          <div className="launch-support mono">
            <FileCode2 size={13} />
            <span>Need a README proof example?</span>
            <Link to="/proof">See how verification works <ArrowRight size={11} /></Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
