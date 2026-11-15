import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./AuthContext.js";

export interface SocketEvent {
  type:
    | "hello"
    | "trade"
    | "token"
    | "king"
    | "activity"
    | "chat"
    | "star"
    | "graduation"
    | "bounty"
    | "proposal"
    | "presence"
    | "pong";
  tokenId?: string;
  data: unknown;
  at?: string;
}

type SocketStatus = "connecting" | "live" | "offline";

interface RealtimeContextValue {
  status: SocketStatus;
  subscribe: (listener: (event: SocketEvent) => void) => () => void;
  subscribeToken: (tokenId: string | null) => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SocketStatus>("connecting");
  const listeners = useRef(new Set<(event: SocketEvent) => void>());
  const channel = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const timers = useRef(new Map<string, number>());

  const subscribe = useCallback((listener: (event: SocketEvent) => void) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);

  const subscribeToken = useCallback((tokenId: string | null) => {
    channel.current = tokenId;
    const socket = wsRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "subscribe",
          tokenIds: tokenId ? [tokenId] : [],
        }),
      );
    }
  }, []);

  const scheduleInvalidate = useCallback(
    (key: string, queryKey: unknown[], delay: number) => {
      const existing = timers.current.get(key);
      if (existing) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        queryClient.invalidateQueries({ queryKey });
        timers.current.delete(key);
      }, delay);
      timers.current.set(key, timer);
    },
    [queryClient],
  );

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer = 0;
    let heartbeat = 0;
    let attempts = 0;

    const connect = () => {
      if (disposed) return;
      setStatus("connecting");
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      try {
        socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
        wsRef.current = socket;
      } catch {
        setStatus("offline");
        scheduleReconnect();
        return;
      }
      socket.onopen = () => {
        attempts = 0;
        setStatus("live");
        if (channel.current) {
          socket?.send(JSON.stringify({ type: "subscribe", tokenIds: [channel.current] }));
        }
        heartbeat = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "ping" }));
          }
        }, 25_000);
      };
      socket.onmessage = (message) => {
        let parsed: SocketEvent;
        try {
          parsed = JSON.parse(String(message.data)) as SocketEvent;
        } catch {
          return;
        }
        if (parsed.type === "pong" || parsed.type === "presence") return;
        if (parsed.type !== "hello" && parsed.type !== "chat") {
          for (const listener of listeners.current) {
            try {
              listener(parsed);
            } catch {
            }
          }
        }
        if (parsed.type === "chat") {
          for (const listener of listeners.current) {
            try {
              listener(parsed);
            } catch {
            }
          }
        }
        if (parsed.type === "trade") {
          const tokenId = parsed.tokenId;
          if (tokenId) scheduleInvalidate(`token-${tokenId}`, ["token"], 700);
          scheduleInvalidate("tabs", ["tokenTabs", parsed.tokenId ?? ""], 900);
          if (parsed.tokenId) scheduleInvalidate("chat", ["chat", parsed.tokenId], 900);
          scheduleInvalidate("home", ["home"], 2200);
          scheduleInvalidate("portfolio", ["portfolio"], 1000);
          scheduleInvalidate("king", ["king"], 1200);
        } else if (parsed.type === "king") {
          scheduleInvalidate("king", ["king"], 120);
          scheduleInvalidate("homeking", ["home"], 700);
          if (parsed.tokenId) scheduleInvalidate(`token-${parsed.tokenId}`, ["token"], 400);
        } else if (parsed.type === "token" || parsed.type === "star" || parsed.type === "graduation") {
          if (parsed.tokenId) {
            scheduleInvalidate(`token-${parsed.tokenId}`, ["token"], 250);
            scheduleInvalidate(`tabs-${parsed.tokenId}`, ["tokenTabs", parsed.tokenId], 400);
          }
          scheduleInvalidate("home", ["home"], 1200);
          scheduleInvalidate("king", ["king"], 500);
        } else if (parsed.type === "activity") {
          scheduleInvalidate("home", ["home"], 800);
          scheduleInvalidate("leaderboard", ["leaderboard"], 1600);
        }
      };
      socket.onerror = () => {
        setStatus("offline");
      };
      socket.onclose = () => {
        if (heartbeat) window.clearInterval(heartbeat);
        setStatus("offline");
        wsRef.current = null;
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (disposed) return;
      attempts += 1;
      const delay = Math.min(12_000, 1_000 * 2 ** Math.min(4, attempts));
      reconnectTimer = window.setTimeout(connect, delay);
    };

    connect();
    return () => {
      disposed = true;
      if (heartbeat) window.clearInterval(heartbeat);
      window.clearTimeout(reconnectTimer);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      wsRef.current = null;
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
    };
  }, [scheduleInvalidate, user?.id]);

  const value = useMemo(
    () => ({ status, subscribe, subscribeToken }),
    [status, subscribe, subscribeToken],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  const context = useContext(RealtimeContext);
  if (!context) throw new Error("useRealtime must be used inside RealtimeProvider");
  return context;
}

export function useRealtimeEvent(handler: (event: SocketEvent) => void): void {
  const { subscribe } = useRealtime();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    return subscribe((event) => handlerRef.current(event));
  }, [subscribe]);
}
