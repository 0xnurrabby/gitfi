# Mainnet deployment

Mainnet is a fresh deployment. Do not point the public app at it until the contracts, database, Worker and a small real market have passed the checklist below.

## What is already in the code

- Star-based launch cap: `$10,000 + $10 per GitHub star`.
- Exact launch price is derived from the launch cap with the live NEAR/USD quote.
- The market step is capped at 0.5% per trade, below the 1.3% trade fee, so a round trip cannot be arbitraged.
- Market buys are pauseable by the owner; sells, unstaking and reward claims remain available.
- Sells remain available after graduation.
- Two-step owner rotation for both contracts.
- Optional per-trade slippage limits: `min_tokens` on buys, `min_near` on sells.
- Per-wallet holding cap enforced by the market contract.
- Registry ownership proof, nonce replay protection, oracle signature age limit and pause control.
- Separate platform fee and creator fee accounting.
- Storage buffer is separate from user reserves.

## Required accounts

Use dedicated accounts. Do not use a personal wallet as the protocol owner.

| Account | Purpose | Suggested balance |
|---|---|---|
| `deployer.near` | Pays contract deploy and gas | 14+ NEAR |
| `owner.near` | Protocol owner; ideally a multisig/DAO | 0.2 NEAR |
| `oracle.<owner>.near` | Repo deed and receipt anchors | 0.2 NEAR |
| `registry.<owner>.near` | Repo registry contract | 4.2 NEAR at create |
| `market.<owner>.near` | Market contract | 8 NEAR, including a 3.7 NEAR storage buffer |
| `fees.<owner>.near` | Platform launch fee address | 0.01 NEAR |

Most of that is **storage staking**, not gas. NEAR gas for the deploy is cents. Contract code is about 798 KB across both contracts, which locks roughly 8 NEAR. That storage deposit is refundable if a contract account is deleted. The remaining balance is the market storage buffer and small account reserves. The deploy script currently requires about **12.61 NEAR plus gas**.

The exact funding depends on current storage prices. Run:

```bash
npm run mainnet:preflight
```

It prints missing environment variables, WASM code hashes, estimated code storage and current account balances.

After the deployer is funded and the env is complete, run:

```bash
# Without MAINNET_CONFIRM this is a dry run and sends nothing.
MAINNET_CONFIRM=DEPLOY npm run mainnet:deploy
```

The script creates the owner, oracle, fees, registry and market subaccounts, deploys both contracts, initializes them, and writes the owner and oracle key files under `data/`. Do not commit those files.

The registry deed oracle public key comes from `data/mainnet-oracle-seed.txt`. The oracle account's transaction key is separate. Set both in Render:

```ini
ORACLE_SEED_HEX=<contents of data/mainnet-oracle-seed.txt>
NEAR_ORACLE_PRIVATE_KEY=<secret_key from data/mainnet-oracle-key.json>
```

## Environment

```ini
MAINNET_DEPLOYER_ACCOUNT=<deployer>.near
MAINNET_OWNER_ACCOUNT=<owner>.near
MAINNET_ORACLE_ACCOUNT=oracle.<owner>.near
MAINNET_REGISTRY_ACCOUNT=registry.<owner>.near
MAINNET_MARKET_ACCOUNT=market.<owner>.near
PLATFORM_FEE_ADDRESS=fees.<owner>.near
MAINNET_RPC_URL=https://rpc.mainnet.fastnear.com
ORACLE_SEED_HEX=<32-byte-hex>
```

Keep the deployer private key in the NEAR credentials directory or pass it only through a local secret store. Never commit it.

## Deploy order

1. Build both contracts for `wasm32-unknown-unknown` in release mode.
2. Create the registry, market and oracle subaccounts under the deployer.
3. Add the oracle public key to the oracle account.
4. Deploy `gitfi_repo_registry.wasm` to the registry account and call:

```text
new(owner_id: <owner>, oracle_public_key: <32-byte array>)
```

5. Deploy `gitfi_market.wasm` to the market account and call:

```text
new(owner_id: <owner>)
```

6. Transfer the market storage buffer to the market account. This is a plain transfer, not `add_reserve`; it must stay outside user reserves.
7. From the owner account, propose ownership from the deployer to the multisig and accept it from the multisig.
8. Set `PLATFORM_FEE_ADDRESS`, `NEAR_ORACLE_ACCOUNT_ID`, `NEAR_ORACLE_PRIVATE_KEY`, contract IDs and mainnet RPC values on Render.
9. Point the Worker `NEAR_RPC_URL` and `NEAR_RPC_FALLBACK_URL` at mainnet, then redeploy.
10. Create a fresh Turso database or back up and clear the testnet database.
11. Run a real launch, buy, sell, stake, unstake and reward claim with a small amount.
12. Only then publish the mainnet links.

## Launch price formula

```text
launch_market_cap_usd = 10,000 + (github_stars * 10)
launch_price_near = launch_market_cap_usd / total_supply / near_usd
```

The market contract stores the resulting yoctoNEAR price. The displayed USD market cap uses the live NEAR/USD quote, so it moves with NEAR after launch. The **launch cap** is fixed at creation.

## Contract security notes

- The 0.5% step cap is enforced in `create_market`. A larger step reverts.
- `buy` is blocked while paused. `sell`, `unstake` and claims stay open.
- The reserve is funded by buys. The platform must keep a storage buffer so storage costs never consume user reserve.
- Per-wallet caps count both liquid and staked tokens.
- The market owner can pause buys, but cannot move user balances or the reserve.
- The registry owner can rotate the oracle key and pause the registry, but cannot mint a deed without a fresh oracle signature.
- A full external audit is still required before meaningful real funds are accepted.

## Rollback

If a mainnet launch fails:

1. Pause buys with `set_paused(true)`.
2. Keep sells and claims open.
3. Do not redeploy over live state without a tested migration.
4. Restore the previous Render environment and Worker RPC values.
5. Investigate from the on-chain transaction hashes before resuming.
