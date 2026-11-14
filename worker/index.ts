interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  API_ORIGIN: string;
  APP_ORIGIN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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
    } catch (error) {
      return new Response(
        JSON.stringify({ error: "API unavailable.", code: "API_UNAVAILABLE" }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
  },
};
