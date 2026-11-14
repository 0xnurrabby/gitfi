# GitFi economics

This document describes the economics of the deployed NEAR testnet market. It is intentionally narrower than the original bonding-curve design note: the live product uses a step-price market, not an off-chain curve or a simulated DEX.

## Units

| Unit | Representation |
|---|---|
| NEAR | yoctoNEAR, `1e24` per NEAR |
| Token | micro-token, `1e6` per whole token |
| Supply | 1,000,000,000 tokens (`1e15` micro-tokens) |
| Initial reserve | 0.05 NEAR per market, paid by the operator |
| Graduation | Sold supply reaches the market's curve target |

All token and fee arithmetic uses integer values.

## Token creation

| Flow | Amount | Recipient |
|---|---:|---|
| Launch fee | 1 NEAR | Team wallet, direct wallet transfer |
| Initial market reserve | 0.05 NEAR | Market contract |

The launch API verifies the team transfer before the market is created. The payment must be final, signed by the launcher and addressed to the configured team wallet. A transaction hash can be used only once.

Only the README-verified owner of a repository can create its token. One repository can have exactly one token and one market.

## Trade fees

Every buy and sell charges **1.3%** of the notional:

| Recipient | Share | Accounting |
|---|---:|---|
| Token creator | 0.50% | `dev_fees[token_id]`, claimable by the market owner |
| Team | 0.30% | `platform_fees`, claimable by the contract owner |
| Token stakers | 0.50% | reward-per-token accumulator, claimable in NEAR |
| **Total** | **1.30%** | |

If a market has no stakers, the 0.50% staker share remains in the contract as team/platform revenue until staking exists. Once users stake, future 0.50% shares accrue to them proportionally.

## Step price market

Each market has:

- `price`: yoctoNEAR per micro-token
- `step`: price increment
- `reserve`: NEAR held to pay sellers
- `sold`: tokens sold from the curve supply
- `curve_supply`: maximum inventory sold through the curve
- `total_supply`: total token supply

A buy:

1. charges the 1.3% fee
2. prices the remaining NEAR at the current step price
3. adds the net NEAR to the reserve
4. advances the price by one step
5. records the buyer's balance and cost basis

A sell:

1. checks the seller's balance
2. prices the tokens at the current step price
3. charges the 1.3% fee
4. pays the net NEAR from the reserve
5. reduces the price by one step
6. reduces the seller's balance and proportional cost basis

A market becomes `graduated` when `sold >= curve_supply`. The curve stops issuing new inventory. The existing market and reserve stay open on-chain. No third-party DEX pool is created.

## Staking

- Stake tokens into the market contract.
- `total_staked` receives the staked amount.
- Every trade's 0.50% staker share increases `reward_per_token`.
- A staker's pending reward is `stake * (reward_per_token - paid_reward_per_token) / scale + accrued`.
- Rewards are claimable in NEAR.
- There is no lock and no inflation. Yield exists only when trading fees exist.

## Bounties

- Anyone can fund a bounty with attached NEAR.
- The reward is escrowed in the market contract.
- The market owner approves a winner and the contract pays the winner.
- The creator can cancel an open bounty and receive a refund.

## Display and settlement

Trading settles in NEAR. The UI displays USD values using a live NEAR/USD quote. USD is a display layer only. The contract records NEAR amounts, token balances, cost basis and trade history.

## Mainnet considerations

- Deploy fresh registry and market contracts with production owner and treasury accounts.
- Complete an external audit.
- Decide whether to add standalone NEP-141 token contracts per repository.
- Decide whether to add a DEX graduation adapter.
- Run a production indexer for trade history and discovery.
- Use a clean production database with no seeded or demo markets.
