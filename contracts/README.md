# GitFi contracts

This folder contains the NEAR-side modules for GitFi:

- **Repo Registry** — one repository, one Repo NFT, one canonical oracle-verified deed.
- **GitFi Market** — real NEAR-quoted markets with wallet-signed buy/sell, on-chain balances, cost basis and trade history.

The Repo Registry is deployed on **NEAR testnet** at [`gitfi-395012.testnet`](https://explorer.testnet.near.org/accounts/gitfi-395012.testnet), and the **GitFi Market** is deployed at `market.gitfi-395012.testnet`. The market owns balances, trades, staking rewards and bounties; the registry owns repo deeds, freeze state and tamper-evident receipt anchors.

## Why the Repo NFT lives on-chain

- A repository can only ever mint one deed. The registry rejects duplicate repo paths and token IDs.
- The deed owner can only be set by a payload signed by the GitFi oracle, which only signs after raw README verification.
- The deed stays staked in the protocol vault; it is never transferred to a marketplace.
- Private/deleted repositories can be marked frozen without moving the deed.
- Oracle keys are rotatable by the protocol owner.
- Trades, launches, graduations and star burns can be anchored with `anchor_event` (oracle-signed receipt digest).

## Deployed state

| Item | Value |
|---|---|
| Account | `gitfi-395012.testnet` |
| Deploy tx | `HG6vzPz1mBQiPLsUK1YsQGXdYy9PjHB8hgnFH35zNKG7` |
| Latest wasm redeploy | `wYxCrqEB5HCpF5svKewe4zyjyADKs8zj3fRvVxUakEQ` |
| Oracle public key | `b025d2300a26ee1062877940d19b46ff43a7f2bba8e499d574e5e47559600975` |
| Code hash | `HBYNqtNiYx59QMBtvoP9UkThLwbEFcpBUgLgXUsnWYzM` |

## Build

```bash
rustup target add wasm32-unknown-unknown
cd contracts
cargo build -p gitfi-repo-registry --target wasm32-unknown-unknown --release
```

The wasm is written to `contracts/target/wasm32-unknown-unknown/release/gitfi_repo_registry.wasm`.

## Deploy / redeploy

First deploy with initialization:

```bash
near contract deploy gitfi-395012.testnet \
  use-file target/wasm32-unknown-unknown/release/gitfi_repo_registry.wasm \
  with-init-call new file-args ../data/init-args.json \
  prepaid-gas 100Tgas attached-deposit 0NEAR \
  network-config testnet sign-with-legacy-keychain send
```

`data/init-args.json`:

```json
{ "owner_id": "gitfi-395012.testnet", "oracle_public_key": [176, 37, "...32 bytes"] }
```

Redeploy code while preserving state:

```bash
near contract deploy gitfi-395012.testnet \
  use-file target/wasm32-unknown-unknown/release/gitfi_repo_registry.wasm \
  without-init-call network-config testnet sign-with-legacy-keychain send
```

## Signature envelope

The oracle signs a Borsh-serialized `DeedMessage`:

```
DeedMessage {
  repo: String,          // lowercased owner/name
  token_id: String,
  owner: Option<AccountId>,
  metadata_uri: String,
  nonce: [u8; 32],
  issued_at: u64,        // nanoseconds
}
```

`anchor_event` signs a separate `AnchorMessage`:

```
AnchorMessage {
  kind: String,          // e.g. trade.settle
  aggregate: String,     // repo, token id or platform
  digest: String,        // 64-char ledger receipt digest
  nonce: [u8; 32],
  issued_at: u64,
}
```

The contract verifies signatures with `env::ed25519_verify`, rejects replayed nonces globally, and requires `issued_at` to be within a 30 minute window. `owner = None` creates an escrowed deed; `claim_repo_deed` releases it with a fresh signature naming the verified owner.

## Methods

| Method | Access | Purpose |
|---|---|---|
| `new(owner_id, oracle_public_key)` | init | Deploy registry |
| `mint_repo_deed(...)` | oracle signature | Mint the unique deed |
| `claim_repo_deed(...)` | oracle signature | Release an escrowed deed |
| `reassign_deed(...)` | oracle signature | Move a staked deed to the real repo owner |
| `anchor_event(...)` | oracle signature | Anchor a ledger receipt |
| `update_metadata_uri(token_id, uri)` | deed owner | Update metadata |
| `set_frozen(token_id, frozen)` | protocol owner | Hide private/deleted repos |
| `set_paused(paused)` | protocol owner | Circuit breaker |
| `set_oracle_public_key(key)` | protocol owner | Key rotation |
| `nft_token`, `nft_tokens_for_owner`, `deed`, `deed_for_repo`, `total_deeds` | view | NEP-171-style reads |

## Security model

- Checked arithmetic only.
- One global nonce set; no replay.
- Unique repo and token indexes enforced on-chain.
- Pausing blocks mints and anchors, not reads.
- No cross-contract calls in the trust path; no reentrancy surface.
- Admin cannot forge a mint without the oracle signature.
- Events include the signed payload digest for independent audit.

---

## GitFi Market

Deployed at [`market.gitfi-395012.testnet`](https://explorer.testnet.near.org/accounts/market.gitfi-395012.testnet) (initial deploy `HX59r7FsvFjftrQzyKZXtmYkwckR2jk8bW9YRwcmoRj4`, v2 migration `9M5kLmQHUmaajTHbDAPH3eTBUMsHtaKiXRc92XXS6PMB`, latest fee deploy `CqDbYYNKf8ZEdveDxJGWwevFVjXwBWDFJXPjAwkHEuwT`, code hash `9mJYo99oEWVYaEvc5wnTRSBhHswtWretzFEA2inaqdzF`).

The market contract is native-NEAR quoted:

- `create_market` (owner) seeds a market and its sell reserve. The app requires a 1 NEAR token-creation fee, sent directly to the team wallet and verified before this owner call.
- `buy(token_id)` accepts attached NEAR, charges a 1.3% fee (0.5% creator / 0.3% team / 0.5% token stakers), mints internal token balance and advances the step price.
- `sell(token_id, token_amount)` burns internal tokens, charges the same fee and transfers NEAR from the reserve to the seller.
- `stake` / `unstake` lock tokens; `claim_staking_rewards` pays the accrued 0.5% fee yield in NEAR.
- `create_bounty` escrows a NEAR reward on-chain; `approve_bounty` (market owner) pays the winner; `cancel_bounty` refunds the creator.
- `get_market`, `get_balance`, `get_cost`, `get_stake`, `get_pending_rewards`, `get_total_staked`, `get_trades`, `get_all_trades`, `get_bounties`, `get_dev_fees` are live views.
- `claim_developer_fees` and `claim_platform_fees` pay accrued fees.

The web app exposes this through `/real/:tokenId` and `GET /api/onchain/market/:tokenId`. Discovery (home, explore, portfolio, leaderboard) reads the same contract, and USD values use a live NEAR/USD quote; trading itself always settles in NEAR. There is no demo-USDC settlement path in the UI.

## What remains deployment-specific

A mainnet launch needs fresh registry/market deployments with production owner and treasury accounts, a clean production database, an external audit, and a product decision on whether to add a third-party DEX pool after curve graduation. The testnet app does not settle trades or balances off-chain: markets, staking rewards and bounties all run in `market.gitfi-395012.testnet` today.
