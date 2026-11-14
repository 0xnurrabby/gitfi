import { useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ChevronDown,
  Command,
  Copy,
  ExternalLink,
  LogOut,
  Menu,
  Moon,
  PlusCircle,
  Sun,
  Terminal,
  UserRound,
  Wallet,
  X,
} from "lucide-react";
import clsx from "clsx";
import { useAuth } from "../contexts/AuthContext.js";
import { useTheme } from "../contexts/ThemeContext.js";
import { api } from "../lib/api.js";
import { formatUsd, truncateAddress } from "../../shared/format.js";
import { Avatar } from "./AssetLogo.js";
import { BrandMark, BrandWord } from "./Brand.js";
import { Badge, buttonClass, CopyButton } from "./ui.js";
import { AuthModal } from "./AuthModal.js";

const NAV = [
  { to: "/explore", label: "Markets" },
  { to: "/launch", label: "Launch" },
  { to: "/portfolio", label: "Portfolio" },
  { to: "/leaderboard", label: "Leaderboard" },
];

interface WalletBalance {
  nearBalance: string;
  nearUsd: number;
  usdMicro: number;
}

function nearLabel(yocto: string | undefined): string {
  if (!yocto) return "0";
  const value = Number(BigInt(yocto) / 10n ** 22n) / 100;
  return value.toLocaleString("en-US", { maximumFractionDigits: value < 1 ? 4 : 2 });
}

export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent("gitfi:command-palette"));
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      className="icon-btn theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      <span className="theme-toggle-inner">
        {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
      </span>
    </button>
  );
}

function AccountMenu() {
  const { user, openAuth, logout, loading } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const { data: wallet } = useQuery({
    queryKey: ["wallet-balance", user?.address],
    queryFn: () => api<WalletBalance>(`/api/onchain/account/${user!.address}`),
    enabled: Boolean(user),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const handle = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  if (loading) {
    return <div className="wallet-skeleton" aria-hidden="true" />;
  }
  if (!user) {
    return (
      <button className={buttonClass("primary", "sm", "wallet-btn")} onClick={openAuth}>
        <Wallet size={14} />
        <span>Connect NEAR</span>
      </button>
    );
  }

  return (
    <div className="account-wrap" ref={ref}>
      <button
        className={clsx("account-trigger", open && "account-trigger-open")}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <Avatar name={user.displayName || user.address} size={26} />
        <span className="account-trigger-copy">
          <span className="account-name">{user.displayName}</span>
          <span className="account-balance mono">{nearLabel(wallet?.nearBalance)} NEAR</span>
        </span>
        <ChevronDown size={13} className={clsx("account-chev", open && "account-chev-open")} />
      </button>
      {open ? (
        <div className="account-menu">
          <div className="account-menu-head">
            <div className="account-menu-name">{user.displayName}</div>
            <div className="account-menu-address mono">{truncateAddress(user.address, 10, 6)}</div>
            <div className="account-menu-badges">
              <Badge tone="green">NEAR</Badge>
              <CopyButton text={user.address} label="Address" />
            </div>
          </div>
          <div className="account-menu-balance">
            <span>Wallet balance</span>
            <strong className="mono">
              {nearLabel(wallet?.nearBalance)} NEAR · {formatUsd(wallet?.usdMicro ?? 0)}
            </strong>
          </div>
          <div className="account-menu-links">
            <Link to="/portfolio" className="account-menu-link">
              <UserRound size={15} /> Portfolio <ArrowRight size={13} className="push-right" />
            </Link>
            <Link to="/launch" className="account-menu-link">
              <PlusCircle size={15} /> Launch a repo <ArrowRight size={13} className="push-right" />
            </Link>
            <button
              className="account-menu-link"
              onClick={() => {
                navigator.clipboard.writeText(user.address);
                setOpen(false);
              }}
            >
              <Copy size={15} /> Copy wallet address
            </button>
            <button
              className="account-menu-link account-menu-logout"
              onClick={() => {
                setOpen(false);
                void logout();
              }}
            >
              <LogOut size={15} /> Disconnect
            </button>
          </div>
          <div className="account-menu-foot mono">
            NEAR TESTNET · ON-CHAIN MARKET
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MobileMenu({ onClose }: { onClose: () => void }) {
  const { user, openAuth } = useAuth();
  return (
    <div className="mobile-menu">
      <div className="mobile-menu-head">
        <BrandMark size={25} />
        <button className="icon-btn" onClick={onClose} aria-label="Close menu">
          <X size={17} />
        </button>
      </div>
      <nav className="mobile-nav">
        {NAV.map((item, index) => (
          <NavLink key={item.to} to={item.to} onClick={onClose} className="mobile-nav-link">
            <span className="mono">0{index + 1}</span>
            {item.label}
            <ArrowRight size={16} />
          </NavLink>
        ))}
        <a href="/docs/" onClick={onClose} className="mobile-nav-link">
          <span className="mono">05</span>
          Docs
          <ArrowRight size={16} />
        </a>
        <NavLink to="/proof" onClick={onClose} className="mobile-nav-link">
          <span className="mono">06</span>
          Proof ledger
          <ArrowRight size={16} />
        </NavLink>
      </nav>
      <div className="mobile-menu-footer">
        {user ? (
          <div>
            <div className="mono muted">{truncateAddress(user.address, 12, 6)}</div>
            <div className="mobile-balance mono">On-chain NEAR portfolio</div>
          </div>
        ) : (
          <button
            className={buttonClass("primary", "md")}
            onClick={() => {
              onClose();
              openAuth();
            }}
          >
            <Wallet size={15} /> Connect NEAR
          </button>
        )}
      </div>
    </div>
  );
}

export function SiteHeader() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => {
    setMobileOpen(false);
    window.scrollTo({ top: 0, behavior: "auto" });
    if (!location.pathname.startsWith("/token/")) {
      document.title = "GitFi.fun — Public code. Priced in public.";
    }
  }, [location.pathname]);

  return (
    <>
      <header className="site-header">
        <div className="header-inner">
          <Link to="/" className="brand" aria-label="GitFi.fun home">
            <BrandMark size={27} />
            <BrandWord />
          </Link>
          <nav className="desktop-nav" aria-label="Primary">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => clsx("nav-link", isActive && "nav-link-active")}
              >
                {item.label}
              </NavLink>
            ))}
            <a href="/docs/" className="nav-link nav-link-docs">
              Docs <span className="nav-external">↗</span>
            </a>
          </nav>
          <div className="header-actions">
            <button className="command-trigger" onClick={openCommandPalette} aria-label="Open command palette">
              <Command size={13} />
              <span>Jump to</span>
              <kbd>⌘K</kbd>
            </button>
            <ThemeToggle />
            <AccountMenu />
            <button
              className="icon-btn mobile-menu-btn"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu size={18} />
            </button>
          </div>
        </div>
      </header>
      {mobileOpen ? <MobileMenu onClose={() => setMobileOpen(false)} /> : null}
      <AuthModal />
    </>
  );
}

export function SiteFooter() {
  const { platform } = useAuth();
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <Link to="/" className="brand">
            <BrandMark size={25} />
            <BrandWord />
          </Link>
          <p>Public code. Priced in public.</p>
          <div className="footer-chain mono">
            <span className="signal-dot" />
            NEAR {platform?.network ?? "testnet"} · on-chain market ledger
          </div>
        </div>
        <div className="footer-col">
          <span className="footer-heading">Protocol</span>
          <Link to="/explore">Markets</Link>
          <Link to="/launch">Launch a repo</Link>
          <Link to="/leaderboard">Leaderboard</Link>
          <a href="/docs/">Docs</a>
          <Link to="/proof">Proof ledger</Link>
        </div>
        <div className="footer-col">
          <span className="footer-heading">Mechanics</span>
          <span>0.5% creator royalty</span>
          <span>0.3% team / 0.5% stakers</span>
          <span>1.3% total trade fee</span>
          <span>1 NEAR launch fee</span>
        </div>
        <div className="footer-col">
          <span className="footer-heading">Built on</span>
          <a href={platform?.contractUrl ?? "https://explorer.testnet.near.org/accounts/gitfi-395012.testnet"} target="_blank" rel="noreferrer">
            {platform?.contractId ?? "gitfi-395012.testnet"} <ExternalLink size={11} />
          </a>
          <span>NEAR testnet deeds</span>
          <span>On-chain NEAR market</span>
        </div>
      </div>
      <div className="footer-bottom">
        <span>© {new Date().getFullYear()} GitFi.fun — testnet build. Trades settle on NEAR testnet.</span>
        <span className="mono">NO GITHUB OAUTH · EVER</span>
      </div>
    </footer>
  );
}
