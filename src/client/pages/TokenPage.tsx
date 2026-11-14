import { Link, Navigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import type { TokenDetail } from "../../shared/types.js";
import { api } from "../lib/api.js";
import { buttonClass, EmptyState, Skeleton } from "../components/ui.js";

/**
 * Legacy /token/:slug links now land on the real NEAR market page. Trading
 * moved on-chain; the old oracle-ledger page is no longer a trading surface.
 */
export function TokenPage() {
  const { slug } = useParams();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["token", slug],
    queryFn: () => api<TokenDetail>(`/api/tokens/${slug}`),
    enabled: Boolean(slug),
  });

  if (isLoading) {
    return (
      <div className="page token-page">
        <Skeleton style={{ height: 80 }} />
        <Skeleton style={{ height: 420, marginTop: 18 }} />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="page">
        <EmptyState
          title="Market not found"
          body="This token may have moved, or the repository is no longer indexed."
          icon={<GitBranch size={24} />}
          action={<Link to="/explore" className={buttonClass("primary")}>Browse markets</Link>}
        />
      </div>
    );
  }

  return <Navigate to={`/real/${data.id}`} replace />;
}
