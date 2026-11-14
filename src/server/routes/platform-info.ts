import { config } from "../config.js";
import { isPaused } from "../db.js";
import { oracleKey } from "../ledger.js";
import type { PlatformInfo } from "../../shared/types.js";

export function getAccountPlatformInfo(): PlatformInfo {
  return {
    paused: isPaused(),
    network: config.nearNetwork,
    contractId: config.nearContractId,
    oraclePublicKey: oracleKey().publicKeyHex,
    feeBps: config.tradeFeeBps,
    developerFeeBps: config.creatorFeeBps,
    platformYieldShareBps: config.platformYieldShareBps,
    teamAddress: config.teamAddress,
    launchFeeYocto: config.launchFeeYocto,
    tradeFeeBps: config.tradeFeeBps,
    creatorFeeBps: config.creatorFeeBps,
    teamFeeBps: config.teamFeeBps,
    stakerFeeBps: config.stakerFeeBps,
    demoMode: config.demoMode,
    chainEnabled: config.nearChainEnabled,
    explorerUrl: config.nearExplorerUrl,
    contractUrl: `${config.nearExplorerUrl.replace(/\/$/, "")}/accounts/${config.nearContractId}`,
    chainAccountId: config.nearOracleAccountId,
  };
}
