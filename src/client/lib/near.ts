import { NearConnector } from "@hot-labs/near-connect";

const connectors = new Map<string, NearConnector>();

export function getNearConnector(network: string): NearConnector {
  const resolved = network === "mainnet" ? "mainnet" : "testnet";
  let connector = connectors.get(resolved);
  if (!connector) {
    connector = new NearConnector({
      network: resolved,
      // Login requires a wallet that can sign a NEP-413 message.
      features: { signMessage: true },
      autoConnect: false,
    });
    connectors.set(resolved, connector);
  }
  return connector;
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
