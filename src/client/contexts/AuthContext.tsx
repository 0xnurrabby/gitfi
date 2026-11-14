import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiRequestError } from "../lib/api.js";
import { clearStoredReferral, getStoredReferral } from "../lib/referral.js";
import { base64ToBytes, getNearConnector } from "../lib/near.js";
import type { NearWalletBase } from "@hot-labs/near-connect";
import type { PlatformInfo, SessionResponse, UserProfile } from "../../shared/types.js";
import { useToast } from "./ToastContext.js";

interface AuthContextValue {
  user: UserProfile | null;
  platform: PlatformInfo | null;
  nearWallet: NearWalletBase | null;
  loading: boolean;
  connecting: boolean;
  authOpen: boolean;
  connectError: string | null;
  openAuth: () => void;
  closeAuth: () => void;
  connectNear: () => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  setUser: (user: UserProfile | null) => void;
  updateDisplayName: (displayName: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [platform, setPlatform] = useState<PlatformInfo | null>(null);
  const [nearWallet, setNearWallet] = useState<NearWalletBase | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<SessionResponse>("/api/auth/session")
      .then((session) => {
        if (!alive) return;
        setUser(session.user);
        setPlatform(session.platform);
      })
      .catch(() => {
        if (!alive) return;
        setUser(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const handleUnauthorized = () => {
      setUser(null);
    };
    window.addEventListener("gitfi:unauthorized", handleUnauthorized);
    return () => window.removeEventListener("gitfi:unauthorized", handleUnauthorized);
  }, []);

  useEffect(() => {
    if (!platform || nearWallet) return;
    let alive = true;
    getNearConnector(platform.network)
      .getConnectedWallet()
      .then(({ wallet }) => {
        if (alive) setNearWallet(wallet);
      })
      .catch(() => {
        // No persisted wallet; the user will connect explicitly.
      });
    return () => {
      alive = false;
    };
  }, [platform, nearWallet]);

  const openAuth = useCallback(() => {
    setConnectError(null);
    setAuthOpen(true);
  }, []);
  const closeAuth = useCallback(() => {
    if (!connecting) setAuthOpen(false);
  }, [connecting]);

  const connectNear = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      const referral = getStoredReferral();
      const challenge = await api<{
        id: string;
        nonce: string;
        message: string;
        recipient: string;
        network: string;
        expiresAt: string;
      }>("/api/auth/near/start", {
        method: "POST",
        body: { referral },
      });
      const network = challenge.network === "mainnet" ? "mainnet" : "testnet";
      const connector = getNearConnector(network);
      const wallet = await connector.connect();
      setNearWallet(wallet);
      const accounts = await wallet.getAccounts({ network });
      const account = accounts[0];
      if (!account) throw new Error("The wallet did not return a NEAR account.");
      const signed = await wallet.signMessage({
        message: challenge.message,
        recipient: challenge.recipient,
        nonce: base64ToBytes(challenge.nonce),
        network,
        signerId: account.accountId,
      });
      const verified = await api<{
        user: UserProfile;
        created: boolean;
        platform: PlatformInfo;
      }>("/api/auth/near/verify", {
        method: "POST",
        body: {
          challengeId: challenge.id,
          accountId: signed.accountId || account.accountId,
          publicKey: signed.publicKey,
          signature: signed.signature,
          referral,
        },
      });
      clearStoredReferral();
      setUser(verified.user);
      setPlatform(verified.platform);
      setAuthOpen(false);
      queryClient.invalidateQueries();
      notify(
        verified.created
          ? `NEAR wallet connected: ${verified.user.address}`
          : `Welcome back, ${verified.user.displayName}.`,
        { kind: "success", title: verified.created ? "Wallet connected" : "Signed in" },
      );
    } catch (error) {
      const message =
        error instanceof ApiRequestError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Could not connect the NEAR wallet.";
      setConnectError(message || "Wallet connection was cancelled.");
      notify(message || "Wallet connection was cancelled.", { kind: "error" });
    } finally {
      setConnecting(false);
    }
  }, [notify, queryClient]);

  const logout = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      setUser(null);
      setNearWallet(null);
      queryClient.clear();
      notify("Wallet disconnected.", { kind: "info" });
    }
  }, [notify, queryClient]);

  const refreshUser = useCallback(async () => {
    try {
      const session = await api<SessionResponse>("/api/auth/session");
      setUser(session.user);
      if (session.platform) setPlatform(session.platform);
    } catch {
      // Keep the last known profile rather than flicker.
    }
  }, []);

  const updateDisplayName = useCallback(
    async (displayName: string) => {
      try {
        const result = await api<{ user: UserProfile }>("/api/auth/profile", {
          method: "PATCH",
          body: { displayName },
        });
        setUser(result.user);
        notify("Display name updated.", { kind: "success" });
      } catch (error) {
        notify(error instanceof ApiRequestError ? error.message : "Could not update profile.", {
          kind: "error",
        });
        throw error;
      }
    },
    [notify],
  );

  const value = useMemo(
    () => ({
      user,
      platform,
      nearWallet,
      loading,
      connecting,
      authOpen,
      connectError,
      openAuth,
      closeAuth,
      connectNear,
      logout,
      refreshUser,
      setUser,
      updateDisplayName,
    }),
    [
      user,
      platform,
      nearWallet,
      loading,
      connecting,
      authOpen,
      connectError,
      openAuth,
      closeAuth,
      connectNear,
      logout,
      refreshUser,
      updateDisplayName,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
