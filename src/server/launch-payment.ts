import { config } from "./config.js";
import { db, nowIso } from "./db.js";
import { GithubError } from "./github.js";
import { rpcTargets } from "./rpc.js";

interface TxAction {
  Transfer?: { deposit?: string };
}

interface TxResponse {
  result?: {
    final_execution_status?: string;
    status?: Record<string, unknown>;
    transaction?: {
      signer_id?: string;
      receiver_id?: string;
      hash?: string;
      actions?: TxAction[];
    };
  };
  error?: { message?: string; data?: unknown };
}

export interface VerifiedLaunchPayment {
  txHash: string;
  amountYocto: string;
}

export function launchPaymentIsUsed(txHash: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM launch_payments WHERE tx_hash = ?").get(txHash),
  );
}

export function recordLaunchPayment(payment: VerifiedLaunchPayment, wallet: string): void {
  db.prepare(
    "INSERT INTO launch_payments(tx_hash, wallet, amount_yocto, created_at) VALUES (?, ?, ?, ?)",
  ).run(payment.txHash, wallet, payment.amountYocto, nowIso());
}

/**
 * Verifies that the launcher paid the fixed launch fee directly to the team
 * address before a token/market can be created. The transaction must be final,
 * signed by the launching wallet, and addressed to the configured team account.
 */
export async function verifyLaunchPayment(
  txHash: string,
  wallet: string,
): Promise<VerifiedLaunchPayment> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{20,100}$/.test(txHash)) {
    throw new GithubError("Invalid launch payment transaction hash.", 400, "PAYMENT_INVALID");
  }
  if (launchPaymentIsUsed(txHash)) {
    throw new GithubError("This launch payment was already used.", 409, "PAYMENT_USED");
  }

  let lastError: Error | null = null;
  for (const target of rpcTargets()) {
    try {
      const response = await fetch(target.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...target.headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tx",
          params: {
            tx_hash: txHash,
            sender_account_id: wallet,
            wait_until: "FINAL",
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await response.json()) as TxResponse;
      if (payload.error) throw new Error(payload.error.message ?? "Transaction lookup failed");
      const result = payload.result;
      const tx = result?.transaction;
      if (!tx) throw new Error("Transaction not found yet.");
      if (tx.signer_id !== wallet) {
        throw new GithubError(
          "The launch payment was signed by a different wallet.",
          403,
          "PAYMENT_WRONG_SIGNER",
        );
      }
      if (tx.receiver_id !== config.teamAddress) {
        throw new GithubError(
          `The launch payment must go directly to ${config.teamAddress}.`,
          422,
          "PAYMENT_WRONG_RECEIVER",
        );
      }
      const status = result?.status;
      if (!status || !("SuccessValue" in status)) {
        throw new GithubError("The launch payment transaction did not succeed.", 422, "PAYMENT_FAILED");
      }
      let paid = 0n;
      for (const action of tx.actions ?? []) {
        if (action.Transfer?.deposit) paid += BigInt(action.Transfer.deposit);
      }
      const required = BigInt(config.launchFeeYocto);
      if (paid < required) {
        throw new GithubError(
          `The launch fee is 1 NEAR. Received ${(Number(paid) / 1e24).toFixed(4)} NEAR.`,
          422,
          "PAYMENT_TOO_SMALL",
        );
      }
      return { txHash, amountYocto: paid.toString() };
    } catch (error) {
      if (error instanceof GithubError) throw error;
      lastError = error instanceof Error ? error : new Error("Payment verification failed");
    }
  }
  throw new GithubError(
    lastError?.message ?? "Could not verify the launch payment on NEAR.",
    502,
    "PAYMENT_VERIFY_FAILED",
  );
}
