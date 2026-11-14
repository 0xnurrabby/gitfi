import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  Command,
  Compass,
  Copy,
  Crown,
  Droplets,
  ExternalLink,
  GitBranch,
  LayoutDashboard,
  Moon,
  PlusCircle,
  Search,
  ShieldCheck,
  Sun,
  Wallet,
  X,
} from "lucide-react";
import clsx from "clsx";
import { useAuth } from "../contexts/AuthContext.js";
import { useTheme } from "../contexts/ThemeContext.js";
import { useToast } from "../contexts/ToastContext.js";
import { api } from "../lib/api.js";
import type { TokenSummary } from "../../shared/types.js";
import { AssetLogo } from "./AssetLogo.js";

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  action: () => void;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { user, openAuth } = useAuth();
  const { theme, toggle } = useTheme();
  const { notify } = useToast();

  useEffect(() => {
    const handleOpen = () => {
      setOpen(true);
      setQuery("");
      setHighlighted(0);
    };
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
        setQuery("");
        setHighlighted(0);
      }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("gitfi:command-palette", handleOpen);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("gitfi:command-palette", handleOpen);
      window.removeEventListener("keydown", handleKey);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => {
      document.body.style.overflow = "";
      window.clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!query.trim()) return;
    const timer = window.setTimeout(() => setHighlighted(0), 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  const { data: search } = useQuery({
    queryKey: ["search-palette", query],
    queryFn: () => api<{ results: TokenSummary[] }>(`/api/search?q=${encodeURIComponent(query)}`),
    enabled: open && query.trim().length > 1,
    staleTime: 10_000,
  });

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  const actions: PaletteItem[] = useMemo(
    () => [
      {
        id: "nav-explore",
        group: "Navigate",
        label: "Browse markets",
        hint: "G",
        icon: <Compass size={16} />,
        action: () => go("/explore"),
      },
      {
        id: "nav-launch",
        group: "Navigate",
        label: "Launch a repository",
        hint: "L",
        icon: <PlusCircle size={16} />,
        action: () => go("/launch"),
      },
      {
        id: "nav-portfolio",
        group: "Navigate",
        label: "Open portfolio",
        icon: <LayoutDashboard size={16} />,
        action: () => go("/portfolio"),
      },
      {
        id: "nav-leaderboard",
        group: "Navigate",
        label: "Trader leaderboard",
        icon: <Crown size={16} />,
        action: () => go("/leaderboard"),
      },
      {
        id: "nav-proof",
        group: "Navigate",
        label: "Verify the proof ledger",
        icon: <ShieldCheck size={16} />,
        action: () => go("/proof"),
      },
      {
        id: "nav-docs",
        group: "Navigate",
        label: "Read the GitFi docs",
        hint: "D",
        icon: <BookOpen size={16} />,
        action: () => {
          window.location.href = "/docs/";
        },
      },
      {
        id: "action-theme",
        group: "Actions",
        label: `Switch to ${theme === "dark" ? "light" : "dark"} mode`,
        icon: theme === "dark" ? <Sun size={16} /> : <Moon size={16} />,
        action: () => toggle(),
      },
      {
        id: "action-wallet",
        group: "Actions",
        label: user ? `${user.displayName} · ${user.address}` : "Connect a NEAR wallet",
        icon: <Wallet size={16} />,
        action: () => {
          setOpen(false);
          if (user) go("/portfolio");
          else openAuth();
        },
      },
    ],
    [go, notify, openAuth, theme, toggle, user],
  );

  const tokenItems: PaletteItem[] = (search?.results ?? []).map((token) => ({
    id: `token-${token.id}`,
    group: "Markets",
    label: `${token.name} · $${token.ticker}`,
    hint: token.repo.fullName,
    icon: <AssetLogo src={token.logoUrl} ticker={token.ticker} size={22} />,
    action: () => go(`/real/${token.id}`),
  }));

  const filteredActions = actions.filter((item) =>
    query
      ? `${item.label} ${item.hint ?? ""} ${item.group}`.toLowerCase().includes(query.toLowerCase())
      : true,
  );
  const items = [...filteredActions, ...tokenItems];
  const groups = [...new Set(items.map((item) => item.group))];

  useEffect(() => {
    if (highlighted >= items.length) setHighlighted(Math.max(0, items.length - 1));
  }, [highlighted, items.length]);

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    item.action();
    if (item.id !== "action-theme") setOpen(false);
  };

  if (!open) return null;

  return createPortal(
    <div className="palette-backdrop" onMouseDown={() => setOpen(false)}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette-search">
          <Search size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setHighlighted((value) => Math.min(items.length - 1, value + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setHighlighted((value) => Math.max(0, value - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                run(items[highlighted]);
              }
            }}
            placeholder="Search markets, jump to a page, run an action…"
            aria-label="Command search"
          />
          <button className="palette-esc" onClick={() => setOpen(false)}>
            ESC
          </button>
        </div>
        <div className="palette-results">
          {items.length === 0 ? (
            <div className="palette-empty">
              <GitBranch size={22} />
              <p>No commands found for “{query}”.</p>
            </div>
          ) : (
            groups.map((group) => {
              const groupItems = items.filter((item) => item.group === group);
              return (
                <div className="palette-group" key={group}>
                  <div className="palette-group-label">{group}</div>
                  {groupItems.map((item) => {
                    const index = items.indexOf(item);
                    return (
                      <button
                        key={item.id}
                        className={clsx("palette-item", index === highlighted && "palette-item-active")}
                        onMouseEnter={() => setHighlighted(index)}
                        onClick={() => run(item)}
                      >
                        <span className="palette-item-icon">{item.icon}</span>
                        <span className="palette-item-label">{item.label}</span>
                        {item.hint ? <span className="palette-item-hint mono">{item.hint}</span> : null}
                        <ArrowRight size={13} className="palette-item-arrow" />
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span className="palette-brand"><Command size={11} /> GitFi command</span>
          <button className="palette-close" onClick={() => setOpen(false)} aria-label="Close">
            <X size={13} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
