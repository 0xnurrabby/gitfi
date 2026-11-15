import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { config } from "./config.js";
import { db } from "./db.js";
import { getKing } from "./king.js";
import { parseCookies, userForSessionRaw } from "./auth.js";

export interface RealtimeEvent {
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
    | "presence";
  tokenId?: string;
  data: unknown;
  at?: string;
}

interface ClientState {
  userId: string | null;
  address: string | null;
  subscriptions: Set<string>;
  chatTokens: Set<string>;
  lastSeen: number;
}

const clients = new Map<WebSocket, ClientState>();
let wss: WebSocketServer | null = null;
let heartbeat: NodeJS.Timeout | null = null;
let kingPulse: NodeJS.Timeout | null = null;
let lastKingId: string | null = null;

export function publish(event: RealtimeEvent): void {
  const payload = JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() });
  for (const [socket, state] of clients) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    if (state.lastSeen < Date.now() - 90_000) continue;
    if (event.type === "chat" && event.tokenId) {
      if (!state.userId) continue;
      if (!state.chatTokens.has(event.tokenId) && !hasChatAccess(state.userId, event.tokenId)) continue;
    }
    const isGlobal =
      event.type === "hello" ||
      event.type === "king" ||
      event.type === "activity" ||
      event.type === "trade" ||
      event.type === "star" ||
      event.type === "graduation";
    if (isGlobal || (event.tokenId && state.subscriptions.has(event.tokenId))) {
      try {
        socket.send(payload);
      } catch {
      }
    }
  }
}

function authorizedChatTokens(userId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT t.id FROM tokens t
       LEFT JOIN holdings h ON h.token_id = t.id AND h.user_id = ?
       WHERE (h.amount_micro >= t.vip_threshold_micro AND h.amount_micro > 0)
          OR t.owner_wallet = (SELECT address FROM users WHERE id = ?)`,
    )
    .all(userId, userId) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

function hasChatAccess(userId: string, tokenId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM tokens t
       LEFT JOIN holdings h ON h.token_id = t.id AND h.user_id = ?
       WHERE t.id = ?
         AND ((h.amount_micro >= t.vip_threshold_micro AND h.amount_micro > 0)
           OR t.owner_wallet = (SELECT address FROM users WHERE id = ?))`,
    )
    .get(userId, tokenId, userId);
  return Boolean(row);
}

export function attachRealtime(server: Server): void {
  wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      wss!.handleUpgrade(request, socket, head, (ws) => {
        wss!.emit("connection", ws, request);
      });
    } catch {
      socket.destroy();
    }
  });

  wss.on("connection", (ws, request) => {
    const cookies = parseCookies(request.headers.cookie);
    const raw = cookies[config.cookieName];
    const user = raw ? userForSessionRaw(raw) : null;
    const state: ClientState = {
      userId: user?.id ?? null,
      address: user?.address ?? null,
      subscriptions: new Set(),
      chatTokens: user ? authorizedChatTokens(user.id) : new Set(),
      lastSeen: Date.now(),
    };
    clients.set(ws, state);
    ws.send(
      JSON.stringify({
        type: "hello",
        data: {
          connected: true,
          address: state.address,
          king: getKing(),
          serverTime: new Date().toISOString(),
        },
        at: new Date().toISOString(),
      }),
    );

    ws.on("message", (rawMessage) => {
      state.lastSeen = Date.now();
      const size = Array.isArray(rawMessage)
        ? rawMessage.reduce((total, part) => total + part.byteLength, 0)
        : rawMessage.byteLength;
      if (size > 16_384) return;
      try {
        const parsed = JSON.parse(rawMessage.toString()) as {
          type?: string;
          tokenIds?: unknown;
          tokenId?: unknown;
        };
        if (parsed.type === "subscribe" && Array.isArray(parsed.tokenIds)) {
          state.subscriptions.clear();
          for (const id of parsed.tokenIds.slice(0, 30)) {
            if (typeof id === "string" && /^tok_[A-Za-z0-9_-]+$/.test(id)) {
              state.subscriptions.add(id);
            }
          }
          ws.send(
            JSON.stringify({
              type: "presence",
              data: { subscribed: [...state.subscriptions].length },
            }),
          );
        } else if (parsed.type === "unsubscribe" && typeof parsed.tokenId === "string") {
          state.subscriptions.delete(parsed.tokenId);
        } else if (parsed.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", data: Date.now() }));
        }
      } catch {
      }
    });

    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [socket, state] of clients) {
      if (state.lastSeen < now - 120_000) {
        socket.terminate();
        clients.delete(socket);
      }
    }
  }, 30_000);
  heartbeat.unref?.();

  kingPulse = setInterval(() => {
    const king = getKing(true);
    if ((king?.token.id ?? null) !== lastKingId) {
      lastKingId = king?.token.id ?? null;
      publish({ type: "king", data: king });
    }
  }, 20_000);
  kingPulse.unref?.();

  const initialKing = getKing();
  lastKingId = initialKing?.token.id ?? null;
}

export function closeRealtime(): void {
  if (heartbeat) clearInterval(heartbeat);
  if (kingPulse) clearInterval(kingPulse);
  wss?.close();
  wss = null;
}

export function realtimeCount(): number {
  return clients.size;
}
