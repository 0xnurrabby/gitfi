import { Link } from "react-router-dom";
import { ArrowLeft, GitBranch } from "lucide-react";
import { buttonClass } from "../components/ui.js";

export function NotFoundPage() {
  return (
    <div className="page not-found-page">
      <span className="mono not-found-code">404 / NOT_FOUND</span>
      <div className="not-found-mark"><GitBranch size={54} strokeWidth={1} /></div>
      <h1>This branch doesn’t exist.</h1>
      <p>The route is not in the repository. Return to the market and pick a live path.</p>
      <Link to="/" className={buttonClass("primary", "md")}>
        <ArrowLeft size={14} /> Back to markets
      </Link>
    </div>
  );
}
