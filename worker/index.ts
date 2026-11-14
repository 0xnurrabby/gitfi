interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  API_ORIGIN: string;
  APP_ORIGIN?: string;
  RPC_PROXY_TOKEN?: string;
  NEAR_RPC_URL?: string;
  NEAR_RPC_FALLBACK_URL?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const RPC_METHODS = new Set([
  "query",
  "send_tx",
  "broadcast_tx_commit",
  "broadcast_tx_async",
  "tx",
  "block",
  "chunk",
  "gas_price",
  "status",
  "validators",
  "network_info",
]);

const QUERY_TYPES = new Set([
  "view_access_key",
  "view_access_key_list",
  "view_account",
  "view_code",
  "view_state",
  "call_function",
]);

async function handleRpc(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!env.RPC_PROXY_TOKEN) return json({ error: "RPC proxy is not configured." }, 503);
  if (request.headers.get("x-gitfi-rpc") !== env.RPC_PROXY_TOKEN) {
    return json({ error: "Unauthorized." }, 401);
  }

  const bodyText = await request.text();
  if (bodyText.length > 256_000) return json({ error: "Request is too large." }, 413);

  let body: { method?: string; params?: { request_type?: string } };
  try {
    body = JSON.parse(bodyText) as typeof body;
  } catch {
    return json({ error: "Invalid JSON." }, 400);
  }
  if (!body.method || !RPC_METHODS.has(body.method)) {
    return json({ error: "Unsupported RPC method." }, 400);
  }
  if (
    body.method === "query" &&
    body.params?.request_type &&
    !QUERY_TYPES.has(body.params.request_type)
  ) {
    return json({ error: "Unsupported query type." }, 400);
  }

  const upstreams = [
    env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com",
    env.NEAR_RPC_FALLBACK_URL ?? "https://rpc.testnet.near.org",
  ].filter(Boolean);

  let last: Response | null = null;
  for (const upstream of [...new Set(upstreams)]) {
    try {
      const response = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: bodyText,
      });
      if (response.status !== 429 && response.status < 500) {
        return new Response(response.body, {
          status: response.status,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      last = response;
    } catch {
      // Try the next RPC endpoint.
    }
  }

  return new Response(last ? last.body : JSON.stringify({ error: "NEAR RPC unavailable." }), {
    status: last?.status ?? 502,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.hostname === "www.gitfi.fun") {
      return Response.redirect(`https://gitfi.fun${url.pathname}${url.search}`, 301);
    }

    if (url.hostname.toLowerCase().startsWith("docs.")) {
      const docsPath = url.pathname === "/" ? "/docs/" : `/docs${url.pathname}`;
      return env.ASSETS.fetch(new Request(new URL(docsPath, url.origin), request));
    }

    if (url.pathname === "/rpc") return handleRpc(request, env);

    const proxied =
      url.pathname === "/api" ||
      url.pathname.startsWith("/api/") ||
      url.pathname === "/ws" ||
      url.pathname.startsWith("/ws/") ||
      url.pathname === "/cdn" ||
      url.pathname.startsWith("/cdn/") ||
      url.pathname === "/uploads" ||
      url.pathname.startsWith("/uploads/");

    if (!proxied) return env.ASSETS.fetch(request);

    const target = new URL(url.pathname + url.search, env.API_ORIGIN);
    const headers = new Headers(request.headers);
    headers.set("host", target.host);
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", "https");
    // The API checks Origin for browser mutations. The public app origin is
    // the trusted frontend; the worker is the only route to the API.
    headers.set("origin", env.APP_ORIGIN || "https://gitfi.fun");

    try {
      return await fetch(target.toString(), {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });
    } catch {
      return new Response(
        JSON.stringify({ error: "API unavailable.", code: "API_UNAVAILABLE" }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
  },

  // Keep the free Render API awake for the testnet demo.
  async scheduled(_event: unknown, env: Env): Promise<void> {
    try {
      await fetch(`${env.API_ORIGIN}/api/health`, { method: "GET" });
    } catch {
      // The next scheduled run will retry.
    }
  },
};
