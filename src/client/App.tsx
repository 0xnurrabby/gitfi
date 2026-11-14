import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "./contexts/AuthContext.js";
import { RealtimeProvider } from "./contexts/RealtimeContext.js";
import { ThemeProvider } from "./contexts/ThemeContext.js";
import { ToastProvider } from "./contexts/ToastContext.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { SiteFooter, SiteHeader } from "./components/Layout.js";
import { HomePage } from "./pages/HomePage.js";
import { NotFoundPage } from "./pages/NotFoundPage.js";
import { Skeleton } from "./components/ui.js";

const ExplorePage = lazy(() =>
  import("./pages/ExplorePage.js").then((module) => ({ default: module.ExplorePage })),
);
const TokenPage = lazy(() =>
  import("./pages/TokenPage.js").then((module) => ({ default: module.TokenPage })),
);
const LaunchPage = lazy(() =>
  import("./pages/LaunchPage.js").then((module) => ({ default: module.LaunchPage })),
);
const PortfolioPage = lazy(() =>
  import("./pages/PortfolioPage.js").then((module) => ({ default: module.PortfolioPage })),
);
const LeaderboardPage = lazy(() =>
  import("./pages/LeaderboardPage.js").then((module) => ({ default: module.LeaderboardPage })),
);
const ProofPage = lazy(() =>
  import("./pages/ProofPage.js").then((module) => ({ default: module.ProofPage })),
);
const OnChainMarketPage = lazy(() =>
  import("./pages/OnChainMarketPage.js").then((module) => ({ default: module.OnChainMarketPage })),
);

function RouteSkeleton() {
  return (
    <div className="page route-skeleton" aria-busy="true">
      <Skeleton style={{ width: 200, height: 12 }} />
      <Skeleton style={{ width: "46%", height: 56, marginTop: 20 }} />
      <Skeleton style={{ width: "32%", height: 20, marginTop: 16 }} />
      <div className="route-skeleton-grid">
        <Skeleton style={{ height: 330 }} />
        <Skeleton style={{ height: 330 }} />
      </div>
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 12_000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: 0,
    },
  },
});

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[gitfi] render error", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fatal-error">
          <span className="mono">RENDER_FAULT</span>
          <h1>The terminal hit an unexpected state.</h1>
          <p>{this.state.error.message}</p>
          <button className="btn btn-primary btn-md" onClick={() => window.location.reload()}>
            Reload the app
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function Shell() {
  return (
    <div className="app-shell">
      <SiteHeader />
      <main className="site-main">
        <Suspense fallback={<RouteSkeleton />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/explore" element={<ExplorePage />} />
            <Route path="/token/:slug" element={<TokenPage />} />
            <Route path="/real/:id" element={<OnChainMarketPage />} />
            <Route path="/launch" element={<LaunchPage />} />
            <Route path="/portfolio" element={<PortfolioPage />} />
            <Route path="/leaderboard" element={<LeaderboardPage />} />
            <Route path="/proof" element={<ProofPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </main>
      <SiteFooter />
      <CommandPalette />
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <BrowserRouter>
              <RealtimeProvider>
                <AppErrorBoundary>
                  <Shell />
                </AppErrorBoundary>
              </RealtimeProvider>
            </BrowserRouter>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
