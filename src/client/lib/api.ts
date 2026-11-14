const BASE = "";

export class ApiRequestError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(message: string, status: number, code = "REQUEST_FAILED", details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  timeoutMs?: number;
};

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 25_000);
  try {
    const headers = new Headers(options.headers);
    if (options.body !== undefined && !(options.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }
    headers.set("Accept", "application/json");
    const response = await fetch(`${BASE}${path}`, {
      ...options,
      headers,
      body:
        options.body === undefined
          ? undefined
          : options.body instanceof FormData
            ? options.body
            : JSON.stringify(options.body),
      credentials: "include",
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    if (!response.ok) {
      if (response.status === 401) {
        window.dispatchEvent(new CustomEvent("gitfi:unauthorized"));
      }
      const body = payload as { error?: string; code?: string; details?: unknown };
      throw new ApiRequestError(
        typeof payload === "string" ? payload : body.error ?? "Request failed.",
        response.status,
        body.code ?? "REQUEST_FAILED",
        body.details,
      );
    }
    return payload as T;
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new ApiRequestError("The request took too long. Try again.", 408, "TIMEOUT");
    }
    throw new ApiRequestError(
      "Could not reach the GitFi API. Check your connection.",
      0,
      "NETWORK_ERROR",
    );
  } finally {
    window.clearTimeout(timeout);
  }
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function idempotencyKey(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
