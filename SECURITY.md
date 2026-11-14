# Security model

GitFi handles three classes of value: token balances, trading fees, and repository ownership proofs. This document describes the current testnet trust boundaries and the work required before accepting production funds.

## Trust boundaries

| Boundary | Current testnet build | Mainnet requirement |
|---|---|---|
| Wallet identity | NEAR Connect + NEP-413, HttpOnly session cookie, on-chain access-key check | Same, plus production session hardening and monitoring |
| Repo ownership | Public README challenge bound to wallet, repo and nonce, oracle-signed deed | Same model, independent review of oracle operations |
| Settlement | NEAR market contract: balances, reserves, trades, staking, bounties | Audited contracts and production indexer |
| Assets | Testnet NEAR only | Real NEAR with treasury, monitoring and incident response |
| GitHub data | Cached REST metadata and raw README fetch | GitHub App for higher limits, still no write scopes |
| Token model | Internal ledger inside the market contract | Optional standalone NEP-141 contracts per repository |

## Authentication and sessions

- One-time NEP-413 challenge with expiry and single use.
- Ed25519 signature verification against the key that signed the challenge.
- The API checks that the key is an active on-chain access key for the account.
- A random bearer token is stored only in an HttpOnly, SameSite=Lax cookie. Only a SHA-256 hash is stored server-side.
- Login rate limits and same-origin mutation checks.
- CSP with no inline script execution.

## Repository ownership

- The challenge line is bound to wallet, repository, nonce and expiry.
- Verification re-fetches the raw README with cache-busting and checks the exact line.
- Only GitHub `owner/repo` input is accepted.
- Public, non-fork, non-archived and non-empty repository policy is rechecked at verification and launch.
- `repo_verifications.repo_id` is unique. A repo already verified by another wallet cannot be reclaimed.
- `tokens.repo_id` is unique. One repository can have one token.
- `repo_nfts.repo_id` is unique. One repository can have one deed.
- Only the verified owner can launch a market. The API rejects `mode: community` and any launch from a different wallet.
- Hidden, private or deleted repositories are removed from discovery and their creator fee claims can be frozen.

## Launch payment

- Token creation costs 1 NEAR, paid directly to the team wallet.
- The server verifies the transaction is final, successful and signed by the launching wallet.
- The receiver must match the configured team address.
- The transfer amount must be at least the configured launch fee.
- A transaction hash is recorded once and cannot be replayed.
- Market creation happens only after the payment and ownership checks pass.

## Market contract

- Buys and sells are wallet-signed contract calls.
- The contract stores balances, cost basis, reserves, fees, stakes, rewards and bounties.
- The sell reserve, creator fees, team fees, staking pool and bounty escrow are accounted separately.
- Checked integer math and explicit bounds are used for pricing and fee splits.
- The server cannot move user funds.
- The contract owner can rotate the protocol owner and manage the team fee claim.
- The market owner can claim creator fees and approve bounties.

## Fees

- Trade fee: 1.3%.
- Creator: 0.5%, claimable by the market owner.
- Team: 0.3%, claimable by the contract owner.
- Stakers: 0.5%, pro-rata and claimable in NEAR.
- If no stakers exist, the staker share remains in the contract as team/platform revenue until staking exists.
- Fee math is integer-based; rounding favors the protocol, never an unbacked payout.

## Media and content

- Logos are processed through Sharp, center-cropped and re-encoded to WebP at 512 px and 128 px.
- Uploaded SVG content is rejected when it contains scripts, event handlers, iframes or foreignObject.
- Static assets use long-lived caching and `X-Content-Type-Options: nosniff`.
- Markdown is rendered with `react-markdown` and `rehype-sanitize`; raw HTML is not enabled.

## Operational controls

- Admin pause state exposed in `/api/health`.
- Rate limits on auth, writes, GitHub requests, payments and launches.
- Prepared SQL statements across the API.
- Launch payments and idempotency keys stored in SQLite for replay protection.
- Secrets are read from environment variables or local credential files and are never committed.

## Known limitations

- The market is a step-price market, not a full constant-product DEX.
- Tokens use an internal ledger inside the market contract, not standalone NEP-141 contracts.
- The contracts have not been externally audited.
- Testnet values have no monetary value.
- Mainnet needs fresh deployments, production owner and treasury accounts, a clean database, monitoring and an audit.

## Reporting

If you find a security issue, do not open a public issue with exploit details. Contact the repository owner privately and include a minimal reproduction.
