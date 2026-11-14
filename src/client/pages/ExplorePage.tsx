import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Filter,
  GitBranch,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import clsx from "clsx";
import type { ExploreResponse } from "../../shared/types.js";
import type { Tier } from "../../shared/economics.js";
import { api, qs } from "../lib/api.js";
import { formatUsd } from "../../shared/format.js";
import { MarketTable } from "../components/Market.js";
import {
  Badge,
  buttonClass,
  EmptyState,
  LiveDot,
  SectionHead,
  Skeleton,
} from "../components/ui.js";
import { useAuth } from "../contexts/AuthContext.js";

const TIERS: Array<{ value: Tier | ""; label: string; note: string }> = [
  { value: "", label: "All tiers", note: "14+" },
  { value: "seed", label: "Fresh / seed", note: "<500★" },
  { value: "rising", label: "Rising", note: "500–10k★" },
  { value: "viral", label: "Viral", note: "10k+★" },
];

const SORTS = [
  { value: "trending", label: "Trending" },
  { value: "volume", label: "Volume" },
  { value: "new", label: "Newest" },
  { value: "progress", label: "Curve progress" },
  { value: "stars", label: "GitHub stars" },
  { value: "marketcap", label: "Market cap" },
];

export function ExplorePage() {
  const [params, setParams] = useSearchParams();
  const { user, openAuth } = useAuth();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [showFilters, setShowFilters] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tier = params.get("tier") ?? "";
  const sort = params.get("sort") ?? "trending";
  const community = params.get("community") ?? "";
  const page = Number(params.get("page") ?? "1");
  const q = params.get("q") ?? "";

  useEffect(() => {
    setSearch(params.get("q") ?? "");
  }, [params]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (search === (params.get("q") ?? "")) return;
      const next = new URLSearchParams(params);
      if (search) next.set("q", search);
      else next.delete("q");
      next.delete("page");
      setParams(next);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search, params, setParams]);

  const query = useQuery({
    queryKey: ["explore", tier, sort, community, q, page],
    queryFn: () =>
      api<ExploreResponse>(
        `/api/tokens${qs({
          tier: tier || undefined,
          sort,
          community: community || undefined,
          q: q || undefined,
          page,
          pageSize: 20,
          status: "live",
        })}`,
      ),
    staleTime: 10_000,
  });

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    setParams(next);
  };

  const clearAll = () => {
    setSearch("");
    setParams(new URLSearchParams());
  };

  const hasFilters = Boolean(tier || community || q || sort !== "trending");
  const totalPages = query.data ? Math.max(1, Math.ceil(query.data.total / query.data.pageSize)) : 1;

  return (
    <div className="page explore-page">
      <div className="page-head explore-head">
        <div>
          <div className="eyebrow">The open market</div>
          <h1 className="page-title">
            Find the code<br />
            <em>before the crowd.</em>
          </h1>
        </div>
        <div className="explore-head-right">
          <div className="explore-stat">
            <span>MARKETS</span>
            <strong className="mono">{query.data?.stats.tokensLaunched ?? "—"}</strong>
          </div>
          <div className="explore-stat">
            <span>24H VOLUME</span>
            <strong className="mono">
              {query.data ? formatUsd(query.data.stats.volume24hMicro, { compact: true }) : "—"}
            </strong>
          </div>
          <div className="explore-stat">
            <span>DEV ROYALTIES</span>
            <strong className="mono">
              {query.data ? formatUsd(query.data.stats.developersEarnedMicro, { compact: true }) : "—"}
            </strong>
          </div>
        </div>
      </div>

      <div className="explore-toolbar">
        <label className="search-field">
          <Search size={15} />
          <input
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search repo, ticker, or name"
            aria-label="Search markets"
          />
          {search ? (
            <button onClick={() => setSearch("")} aria-label="Clear search">
              <X size={13} />
            </button>
          ) : (
            <kbd>/</kbd>
          )}
        </label>
        <div className="tier-tabs">
          {TIERS.map((item) => (
            <button
              key={item.value || "all"}
              className={clsx("tier-tab", tier === item.value && "tier-tab-active")}
              onClick={() => update("tier", item.value)}
            >
              {item.label}
              <span className="mono">{item.note}</span>
            </button>
          ))}
        </div>
        <button
          className={clsx("filter-toggle", showFilters && "filter-toggle-open")}
          onClick={() => setShowFilters((value) => !value)}
        >
          <SlidersHorizontal size={14} /> Filters
          {hasFilters ? <span className="filter-dot" /> : null}
        </button>
      </div>

      {showFilters ? (
        <div className="filter-panel">
          <div className="filter-group">
            <span className="filter-label">Ownership</span>
            <div className="filter-chips">
              <button
                className={clsx("chip", !community && "chip-active")}
                onClick={() => update("community", "")}
              >
                All assets
              </button>
              <button
                className={clsx("chip", community === "verified" && "chip-active")}
                onClick={() => update("community", "verified")}
              >
                <BadgeCheck size={12} /> Verified repos
              </button>
              <button
                className={clsx("chip", community === "community" && "chip-active")}
                onClick={() => update("community", "community")}
              >
                <Sparkles size={12} /> Community indexed
              </button>
            </div>
          </div>
          <div className="filter-group">
            <span className="filter-label">Sort</span>
            <select value={sort} onChange={(event) => update("sort", event.target.value)}>
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {hasFilters ? (
            <button className="filter-clear" onClick={clearAll}>
              <X size={13} /> Reset filters
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="explore-meta">
        <div className="explore-meta-left">
          <LiveDot label="markets streaming" />
          <span className="mono">{query.data?.total ?? 0} assets</span>
          {q ? <Badge tone="outline">“{q}”</Badge> : null}
        </div>
        <div className="explore-meta-right mono">
          <Filter size={11} /> README-verified & public only
        </div>
      </div>

      {query.isError ? (
        <EmptyState
          title="Could not load markets"
          body="Check the API connection and try again."
          icon={<GitBranch size={24} />}
          action={<button className={buttonClass("primary")} onClick={() => query.refetch()}>Retry</button>}
        />
      ) : (
        <div className="explore-table-panel">
          <MarketTable tokens={query.data?.tokens ?? []} loading={query.isLoading} />
        </div>
      )}

      {query.data && totalPages > 1 ? (
        <div className="pagination">
          <button
            className={buttonClass("secondary", "sm")}
            disabled={page <= 1}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set("page", String(page - 1));
              setParams(next);
            }}
          >
            <ArrowLeft size={13} /> Previous
          </button>
          <span className="mono">
            PAGE {String(page).padStart(2, "0")} / {String(totalPages).padStart(2, "0")}
          </span>
          <button
            className={buttonClass("secondary", "sm")}
            disabled={page >= totalPages}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set("page", String(page + 1));
              setParams(next);
            }}
          >
            Next <ArrowRight size={13} />
          </button>
        </div>
      ) : null}

      <div className="explore-bottom-cta">
        <div>
          <span className="eyebrow">Don’t see your repo?</span>
          <h3>Every public commit deserves a market.</h3>
          <p>Verify a repository in minutes, or community-index a project before its maintainer arrives.</p>
        </div>
        <div className="explore-cta-actions">
          {user ? (
            <Link to="/launch" className={buttonClass("primary")}>
              Launch a repository <ArrowRight size={14} />
            </Link>
          ) : (
            <button className={buttonClass("primary")} onClick={openAuth}>
              Connect to launch <ArrowRight size={14} />
            </button>
          )}
          <Link to="/leaderboard" className={buttonClass("secondary")}>
            See top traders
          </Link>
        </div>
      </div>
    </div>
  );
}
