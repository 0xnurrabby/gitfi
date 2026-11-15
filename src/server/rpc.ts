import { config } from "./config.js";

export interface RpcTarget {
  url: string;
  headers: Record<string, string>;
}

export function rpcTargets(): RpcTarget[] {
  const targets: RpcTarget[] = [];
  if (config.nearRpcProxyUrl) {
    targets.push({
      url: config.nearRpcProxyUrl,
      headers: config.nearRpcProxyToken ? { "x-gitfi-rpc": config.nearRpcProxyToken } : {},
    });
  }
  targets.push({ url: config.nearRpcUrl, headers: {} });
  targets.push({
    url:
      config.nearNetwork === "mainnet"
        ? "https://rpc.mainnet.near.org"
        : "https://rpc.testnet.near.org",
    headers: {},
  });

  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.url}|${target.headers["x-gitfi-rpc"] ?? ""}`;
    if (!target.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function rpcTarget(): RpcTarget {
  return rpcTargets()[0]!;
}
