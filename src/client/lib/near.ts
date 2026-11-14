import { NearConnector } from "@hot-labs/near-connect";

let connector: NearConnector | null = null;

export function getNearConnector(network: string): NearConnector {
  if (!connector) {
    connector = new NearConnector({
      network: network === "mainnet" ? "mainnet" : "testnet",
      // Login requires a wallet that can sign a NEP-413 message.
      features: { signMessage: true },
      autoConnect: false,
    });
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
