//! GitFi Market v2
//!
//! Real NEAR-quoted markets for GitFi repo tokens. The contract holds the
//! sell-side reserve, tracks each account's token balance and cost basis,
//! distributes half of every trade fee to token stakers, and escrows
//! on-chain bounties. The Repo Registry still owns the deed.

use borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault, Promise};
use serde::{Deserialize, Serialize};

const BPS: u128 = 10_000;
const TRADE_FEE_BPS: u128 = 130; // 1.30%
const CREATOR_SHARE_BPS: u128 = 50; // 0.50% of notional -> token creator
const PLATFORM_SHARE_BPS: u128 = 30; // 0.30% of notional -> platform
const REWARD_SCALE: u128 = 1_000_000;
const MAX_TICKER_LEN: usize = 12;
/// A step larger than this can be arbitraged against the trade fee.
const MAX_STEP_BPS: u128 = 50; // 0.50%

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Market {
    pub token_id: String,
    pub repo: String,
    pub ticker: String,
    pub owner: Option<AccountId>,
    /// yoctoNEAR per micro-token
    pub price: u128,
    /// price increment after each trade, in yoctoNEAR
    pub step: u128,
    /// NEAR held by the contract to pay sellers
    pub reserve: u128,
    pub sold: u128,
    pub total_supply: u128,
    pub curve_supply: u128,
    pub max_wallet: u128,
    pub status: String,
    pub created_at: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct TradeRecord {
    pub id: u64,
    pub token_id: String,
    pub account_id: AccountId,
    pub side: String,
    /// yoctoNEAR paid or received
    pub near_amount: u128,
    /// micro-tokens
    pub token_amount: u128,
    pub price: u128,
    pub timestamp: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Bounty {
    pub id: u64,
    pub token_id: String,
    pub creator: AccountId,
    pub title: String,
    pub description: String,
    /// yoctoNEAR held in escrow
    pub reward: u128,
    pub status: String,
    pub winner: Option<AccountId>,
    pub created_at: u64,
    pub paid_at: Option<u64>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    pub markets: UnorderedMap<String, Market>,
    pub balances: LookupMap<String, u128>,
    pub costs: LookupMap<String, u128>,
    pub dev_fees: LookupMap<String, u128>,
    pub platform_fees: u128,
    pub history: UnorderedMap<u64, TradeRecord>,
    pub next_trade_id: u64,
    // v2: on-chain staking reward accounting
    pub stakes: LookupMap<String, u128>,
    pub total_staked: LookupMap<String, u128>,
    pub reward_per_token: LookupMap<String, u128>,
    pub paid_reward_per_token: LookupMap<String, u128>,
    pub accrued_rewards: LookupMap<String, u128>,
    // v2: on-chain bounty escrow
    pub bounties: UnorderedMap<u64, Bounty>,
    pub next_bounty_id: u64,
    pub paused: bool,
    pub pending_owner: Option<AccountId>,
}

fn balance_key(token_id: &str, account_id: &AccountId) -> String {
    format!("{}|{}", token_id, account_id)
}

fn mul_div(a: u128, b: u128, d: u128) -> u128 {
    assert!(d > 0, "division by zero");
    let quotient = a / d;
    let remainder = a % d;
    quotient
        .checked_mul(b)
        .and_then(|value| value.checked_add(remainder.checked_mul(b)? / d))
        .expect("reward math overflow")
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            markets: UnorderedMap::new(b"m_markets".to_vec()),
            balances: LookupMap::new(b"m_balances".to_vec()),
            costs: LookupMap::new(b"m_costs".to_vec()),
            dev_fees: LookupMap::new(b"m_devfees".to_vec()),
            platform_fees: 0,
            history: UnorderedMap::new(b"m_history".to_vec()),
            next_trade_id: 1,
            stakes: LookupMap::new(b"m_stakes".to_vec()),
            total_staked: LookupMap::new(b"m_totalstaked".to_vec()),
            reward_per_token: LookupMap::new(b"m_rpt".to_vec()),
            paid_reward_per_token: LookupMap::new(b"m_paidrpt".to_vec()),
            accrued_rewards: LookupMap::new(b"m_accrued".to_vec()),
            bounties: UnorderedMap::new(b"m_bounties".to_vec()),
            next_bounty_id: 1,
            paused: false,
            pending_owner: None,
        }
    }

    #[payable]
    pub fn create_market(
        &mut self,
        token_id: String,
        repo: String,
        ticker: String,
        mowner: Option<AccountId>,
        total_supply: U128,
        curve_supply: U128,
        price: U128,
        step: U128,
        max_wallet: U128,
    ) -> Market {
        self.assert_owner();
        assert!(self.markets.get(&token_id).is_none(), "market already exists");
        assert!(total_supply.0 > 0, "supply required");
        assert!(curve_supply.0 > 0 && curve_supply.0 <= total_supply.0, "bad curve supply");
        assert!(price.0 > 0, "price required");
        assert!(
            step.0 <= price.0 * MAX_STEP_BPS / BPS,
            "step too large"
        );
        assert!(ticker.len() <= MAX_TICKER_LEN, "ticker too long");
        let reserve = env::attached_deposit().as_yoctonear();
        let market = Market {
            token_id: token_id.clone(),
            repo,
            ticker,
            owner: mowner,
            price: price.0,
            step: step.0.max(1),
            reserve,
            sold: 0,
            total_supply: total_supply.0,
            curve_supply: curve_supply.0,
            max_wallet: max_wallet.0,
            status: "bonding".to_string(),
            created_at: env::block_timestamp(),
        };
        self.markets.insert(&token_id, &market);
        env::log_str(
            &serde_json::json!({
                "standard": "gitfi-market/2.0",
                "event": "market_create",
                "token_id": token_id,
                "repo": market.repo,
                "price": market.price.to_string(),
                "reserve": reserve.to_string(),
            })
            .to_string(),
        );
        market
    }

    /// Buy with attached NEAR. 1.3% fee: 0.5% creator, 0.3% platform, 0.5% stakers.
    #[payable]
    pub fn buy(&mut self, token_id: String, min_tokens: Option<U128>) -> U128 {
        assert!(!self.paused, "buying is paused");
        let deposit = env::attached_deposit().as_yoctonear();
        assert!(deposit > 0, "send NEAR to buy");
        let buyer = env::predecessor_account_id();
        let mut market = self.markets.get(&token_id).expect("market not found");
        assert!(market.status == "bonding", "market graduated");
        let fee = deposit * TRADE_FEE_BPS / BPS;
        let net = deposit - fee;
        let tokens = net / market.price;
        assert!(tokens > 0, "amount too small");
        if let Some(minimum) = min_tokens {
            assert!(tokens >= minimum.0, "slippage: fewer tokens than minimum");
        }
        assert!(
            market.sold + tokens <= market.curve_supply,
            "not enough curve inventory"
        );
        if market.max_wallet > 0 {
            let key = balance_key(&token_id, &buyer);
            let holding = self.balances.get(&key).unwrap_or(0) + self.stakes.get(&key).unwrap_or(0);
            assert!(
                holding + tokens <= market.max_wallet,
                "wallet holding cap reached"
            );
        }

        market.sold += tokens;
        market.reserve += net;
        market.price += market.step;
        if market.sold >= market.curve_supply {
            market.status = "graduated".to_string();
        }
        self.markets.insert(&token_id, &market);

        let key = balance_key(&token_id, &buyer);
        let balance = self.balances.get(&key).unwrap_or(0) + tokens;
        self.balances.insert(&key, &balance);
        let cost = self.costs.get(&key).unwrap_or(0) + deposit;
        self.costs.insert(&key, &cost);

        self.split_fee(&token_id, fee, deposit);

        self.record_trade(&market, &buyer, "buy", deposit, tokens);
        env::log_str(
            &serde_json::json!({
                "standard": "gitfi-market/2.0",
                "event": "trade",
                "side": "buy",
                "token_id": token_id,
                "account_id": buyer,
                "near": deposit.to_string(),
                "tokens": tokens.to_string(),
                "price": market.price.to_string(),
                "fee": fee.to_string(),
            })
            .to_string(),
        );
        U128(tokens)
    }

    /// Sell tokens back into the contract reserve at the current price.
    pub fn sell(&mut self, token_id: String, token_amount: U128, min_near: Option<U128>) -> Promise {
        let seller = env::predecessor_account_id();
        let tokens = token_amount.0;
        assert!(tokens > 0, "amount required");
        let mut market = self.markets.get(&token_id).expect("market not found");
        assert!(
            market.status == "bonding" || market.status == "graduated",
            "market closed"
        );
        let key = balance_key(&token_id, &seller);
        let balance = self.balances.get(&key).unwrap_or(0);
        assert!(balance >= tokens, "insufficient tokens");

        let gross = tokens * market.price;
        let fee = gross * TRADE_FEE_BPS / BPS;
        let net = gross - fee;
        if let Some(minimum) = min_near {
            assert!(net >= minimum.0, "slippage: less NEAR than minimum");
        }
        assert!(market.reserve >= net, "market reserve too small");

        market.reserve -= net;
        market.sold = market.sold.saturating_sub(tokens);
        market.price = market.price.saturating_sub(market.step).max(1);
        self.markets.insert(&token_id, &market);

        self.balances.insert(&key, &(balance - tokens));
        let old_cost = self.costs.get(&key).unwrap_or(0);
        let cost_removed = old_cost * tokens / balance;
        self.costs.insert(&key, &(old_cost - cost_removed));

        self.split_fee(&token_id, fee, gross);

        self.record_trade(&market, &seller, "sell", net, tokens);
        env::log_str(
            &serde_json::json!({
                "standard": "gitfi-market/2.0",
                "event": "trade",
                "side": "sell",
                "token_id": token_id,
                "account_id": seller,
                "near": net.to_string(),
                "tokens": tokens.to_string(),
                "price": market.price.to_string(),
                "fee": fee.to_string(),
            })
            .to_string(),
        );
        Promise::new(seller).transfer(NearToken::from_yoctonear(net))
    }

    // ------------------------------ staking ------------------------------

    /// Lock tokens and earn a pro-rata share of every trade fee.
    pub fn stake(&mut self, token_id: String, token_amount: U128) {
        let caller = env::predecessor_account_id();
        let tokens = token_amount.0;
        assert!(tokens > 0, "amount required");
        let key = balance_key(&token_id, &caller);
        let balance = self.balances.get(&key).unwrap_or(0);
        assert!(balance >= tokens, "insufficient tokens");
        self.settle_rewards(&token_id, &key);
        self.balances.insert(&key, &(balance - tokens));
        let stake = self.stakes.get(&key).unwrap_or(0) + tokens;
        self.stakes.insert(&key, &stake);
        let total = self.total_staked.get(&token_id).unwrap_or(0) + tokens;
        self.total_staked.insert(&token_id, &total);
        env::log_str(
            &serde_json::json!({
                "standard": "gitfi-market/2.0",
                "event": "stake",
                "token_id": token_id,
                "account_id": caller,
                "tokens": tokens.to_string(),
            })
            .to_string(),
        );
    }

    pub fn unstake(&mut self, token_id: String, token_amount: U128) {
        let caller = env::predecessor_account_id();
        let tokens = token_amount.0;
        assert!(tokens > 0, "amount required");
        let key = balance_key(&token_id, &caller);
        let stake = self.stakes.get(&key).unwrap_or(0);
        assert!(stake >= tokens, "insufficient stake");
        self.settle_rewards(&token_id, &key);
        self.stakes.insert(&key, &(stake - tokens));
        let total = self.total_staked.get(&token_id).unwrap_or(0);
        self.total_staked.insert(&token_id, &total.saturating_sub(tokens));
        let balance = self.balances.get(&key).unwrap_or(0) + tokens;
        self.balances.insert(&key, &balance);
        env::log_str(
            &serde_json::json!({
                "standard": "gitfi-market/2.0",
                "event": "unstake",
                "token_id": token_id,
                "account_id": caller,
                "tokens": tokens.to_string(),
            })
            .to_string(),
        );
    }

    pub fn claim_staking_rewards(&mut self, token_id: String) -> Promise {
        let caller = env::predecessor_account_id();
        let key = balance_key(&token_id, &caller);
        self.settle_rewards(&token_id, &key);
        let amount = self.accrued_rewards.get(&key).unwrap_or(0);
        assert!(amount > 0, "nothing to claim");
        self.accrued_rewards.insert(&key, &0);
        env::log_str(
            &serde_json::json!({
                "standard": "gitfi-market/2.0",
                "event": "claim_rewards",
                "token_id": token_id,
                "account_id": caller,
                "near": amount.to_string(),
            })
            .to_string(),
        );
        Promise::new(caller).transfer(NearToken::from_yoctonear(amount))
    }

    // ------------------------------ bounties ------------------------------

    /// Anyone can fund a real on-chain bounty for a repo. The NEAR stays in
    /// escrow until the market owner approves a winner or the creator cancels.
    #[payable]
    pub fn create_bounty(
        &mut self,
        token_id: String,
        title: String,
        description: String,
    ) -> Bounty {
        let creator = env::predecessor_account_id();
        let reward = env::attached_deposit().as_yoctonear();
        assert!(reward > 0, "bounty reward required");
        assert!(!title.trim().is_empty(), "title required");
        assert!(title.len() <= 120, "title too long");
        assert!(description.len() <= 600, "description too long");
        assert!(self.markets.get(&token_id).is_some(), "market not found");
        let id = self.next_bounty_id;
        self.next_bounty_id += 1;
        let bounty = Bounty {
            id,
            token_id: token_id.clone(),
            creator: creator.clone(),
            title,
            description,
            reward,
            status: "open".to_string(),
            winner: None,
            created_at: env::block_timestamp(),
            paid_at: None,
        };
        self.bounties.insert(&id, &bounty);
        env::log_str(
            &serde_json::json!({
                "standard": "gitfi-market/2.0",
                "event": "bounty_create",
                "token_id": token_id,
                "bounty_id": id,
                "creator": creator,
                "reward": reward.to_string(),
            })
            .to_string(),
        );
        bounty
    }

    /// Only the repo's market owner can approve a winner. The escrow pays out
    /// in the same transaction and the bounty is closed forever.
    pub fn approve_bounty(&mut self, bounty_id: u64, winner: AccountId) -> Promise {
        let caller = env::predecessor_account_id();
        let mut bounty = self.bounties.get(&bounty_id).expect("bounty not found");
        assert!(bounty.status == "open", "bounty not open");
        let market = self
            .markets
            .get(&bounty.token_id)
            .expect("market not found");
        assert_eq!(market.owner, Some(caller), "market owner only");
        bounty.status = "paid".to_string();
        bounty.winner = Some(winner.clone());
        bounty.paid_at = Some(env::block_timestamp());
        self.bounties.insert(&bounty_id, &bounty);
        env::log_str(
            &serde_json::json!({
                "standard": "gitfi-market/2.0",
                "event": "bounty_paid",
                "token_id": bounty.token_id,
                "bounty_id": bounty_id,
                "winner": winner,
                "reward": bounty.reward.to_string(),
            })
            .to_string(),
        );
        Promise::new(winner).transfer(NearToken::from_yoctonear(bounty.reward))
    }

    pub fn cancel_bounty(&mut self, bounty_id: u64) -> Promise {
        let caller = env::predecessor_account_id();
        let mut bounty = self.bounties.get(&bounty_id).expect("bounty not found");
        assert!(bounty.status == "open", "bounty not open");
        assert_eq!(bounty.creator, caller, "creator only");
        bounty.status = "cancelled".to_string();
        self.bounties.insert(&bounty_id, &bounty);
        Promise::new(caller).transfer(NearToken::from_yoctonear(bounty.reward))
    }

    // ------------------------------ owner ------------------------------

    pub fn set_market_owner(&mut self, token_id: String, new_owner: AccountId) {
        self.assert_owner();
        let mut market = self.markets.get(&token_id).expect("market not found");
        market.owner = Some(new_owner);
        self.markets.insert(&token_id, &market);
    }

    /// Start a two-step ownership transfer. The new owner must accept it.
    pub fn propose_owner(&mut self, new_owner: AccountId) {
        self.assert_owner();
        assert_ne!(new_owner, self.owner_id, "already owner");
        self.pending_owner = Some(new_owner);
    }

    pub fn accept_owner(&mut self) {
        let pending = self.pending_owner.clone().expect("no pending owner");
        assert_eq!(env::predecessor_account_id(), pending, "pending owner only");
        self.owner_id = pending;
        self.pending_owner = None;
    }

    pub fn paused(&self) -> bool {
        self.paused
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    pub fn claim_developer_fees(&mut self, token_id: String) -> Promise {
        let caller = env::predecessor_account_id();
        let market = self.markets.get(&token_id).expect("market not found");
        assert_eq!(market.owner, Some(caller.clone()), "market owner only");
        let amount = self.dev_fees.get(&token_id).unwrap_or(0);
        assert!(amount > 0, "nothing to claim");
        self.dev_fees.insert(&token_id, &0);
        Promise::new(caller).transfer(NearToken::from_yoctonear(amount))
    }

    pub fn claim_platform_fees(&mut self) -> Promise {
        self.assert_owner();
        let amount = self.platform_fees;
        assert!(amount > 0, "nothing to claim");
        self.platform_fees = 0;
        Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(amount))
    }

    /// Owner can top up the reserve of a market so sells keep working.
    #[payable]
    pub fn add_reserve(&mut self, token_id: String) {
        self.assert_owner();
        let amount = env::attached_deposit().as_yoctonear();
        assert!(amount > 0, "reserve required");
        let mut market = self.markets.get(&token_id).expect("market not found");
        market.reserve += amount;
        self.markets.insert(&token_id, &market);
    }

    // ------------------------------- views -------------------------------

    pub fn get_market(&self, token_id: String) -> Option<Market> {
        self.markets.get(&token_id)
    }

    pub fn get_markets(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Market> {
        let start = from_index.unwrap_or(0);
        let max = limit.unwrap_or(100).min(200);
        self.markets
            .iter()
            .skip(start as usize)
            .take(max as usize)
            .map(|(_, market)| market)
            .collect()
    }

    pub fn get_balance(&self, token_id: String, account_id: AccountId) -> U128 {
        U128(self.balances.get(&balance_key(&token_id, &account_id)).unwrap_or(0))
    }

    pub fn get_cost(&self, token_id: String, account_id: AccountId) -> U128 {
        U128(self.costs.get(&balance_key(&token_id, &account_id)).unwrap_or(0))
    }

    pub fn get_stake(&self, token_id: String, account_id: AccountId) -> U128 {
        U128(self.stakes.get(&balance_key(&token_id, &account_id)).unwrap_or(0))
    }

    pub fn get_total_staked(&self, token_id: String) -> U128 {
        U128(self.total_staked.get(&token_id).unwrap_or(0))
    }

    pub fn get_pending_rewards(&self, token_id: String, account_id: AccountId) -> U128 {
        let key = balance_key(&token_id, &account_id);
        U128(self.pending_rewards(&token_id, &key))
    }

    pub fn get_trades(&self, token_id: String, limit: Option<u64>) -> Vec<TradeRecord> {
        let max = limit.unwrap_or(50).min(200) as usize;
        let mut rows: Vec<TradeRecord> = self
            .history
            .iter()
            .map(|(_, trade)| trade)
            .filter(|trade| trade.token_id == token_id)
            .collect();
        rows.sort_by(|a, b| b.id.cmp(&a.id));
        rows.truncate(max);
        rows
    }

    /// Newest trades across every market, for the on-chain indexer.
    pub fn get_all_trades(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<TradeRecord> {
        let start = from_index.unwrap_or(0);
        let max = limit.unwrap_or(200).min(500);
        let mut rows: Vec<TradeRecord> = self.history.iter().map(|(_, trade)| trade).collect();
        rows.sort_by(|a, b| b.id.cmp(&a.id));
        rows.into_iter().skip(start as usize).take(max as usize).collect()
    }

    pub fn get_bounties(&self, token_id: String, limit: Option<u64>) -> Vec<Bounty> {
        let max = limit.unwrap_or(50).min(100) as usize;
        let mut rows: Vec<Bounty> = self
            .bounties
            .iter()
            .map(|(_, bounty)| bounty)
            .filter(|bounty| bounty.token_id == token_id)
            .collect();
        rows.sort_by(|a, b| b.id.cmp(&a.id));
        rows.truncate(max);
        rows
    }

    pub fn get_dev_fees(&self, token_id: String) -> U128 {
        U128(self.dev_fees.get(&token_id).unwrap_or(0))
    }

    pub fn get_platform_fees(&self) -> U128 {
        U128(self.platform_fees)
    }
}

impl Contract {
    fn assert_owner(&self) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "owner only");
    }

    /// Split the 1% trade fee: half to the developer, half to stakers. If a
    /// market has no stakers, its half remains platform revenue.
    /// Split the 1.3% trade fee: 0.5% creator, 0.3% platform, 0.5% stakers.
    /// If a market has no stakers, its 0.5% remains platform revenue.
    fn split_fee(&mut self, token_id: &String, fee: u128, notional: u128) {
        let creator_fee = notional * CREATOR_SHARE_BPS / BPS;
        let platform_fee = notional * PLATFORM_SHARE_BPS / BPS;
        let staker_pool = fee.saturating_sub(creator_fee).saturating_sub(platform_fee);
        let current_dev = self.dev_fees.get(token_id).unwrap_or(0);
        self.dev_fees.insert(token_id, &(current_dev + creator_fee));
        self.platform_fees += platform_fee;
        let total_staked = self.total_staked.get(token_id).unwrap_or(0);
        if total_staked > 0 && staker_pool > 0 {
            let current = self.reward_per_token.get(token_id).unwrap_or(0);
            let increment = mul_div(staker_pool, REWARD_SCALE, total_staked);
            self.reward_per_token.insert(token_id, &(current + increment));
        } else {
            self.platform_fees += staker_pool;
        }
    }

    fn pending_rewards(&self, token_id: &String, key: &String) -> u128 {
        let stake = self.stakes.get(key).unwrap_or(0);
        let accrued = self.accrued_rewards.get(key).unwrap_or(0);
        if stake == 0 {
            return accrued;
        }
        let rpt = self.reward_per_token.get(token_id).unwrap_or(0);
        let paid = self.paid_reward_per_token.get(key).unwrap_or(0);
        let delta = rpt.saturating_sub(paid);
        accrued + mul_div(stake, delta, REWARD_SCALE)
    }

    fn settle_rewards(&mut self, token_id: &String, key: &String) {
        let pending = self.pending_rewards(token_id, key);
        self.accrued_rewards.insert(key, &pending);
        let rpt = self.reward_per_token.get(token_id).unwrap_or(0);
        self.paid_reward_per_token.insert(key, &rpt);
    }

    fn record_trade(
        &mut self,
        market: &Market,
        account_id: &AccountId,
        side: &str,
        near_amount: u128,
        token_amount: u128,
    ) {
        let id = self.next_trade_id;
        self.next_trade_id += 1;
        let trade = TradeRecord {
            id,
            token_id: market.token_id.clone(),
            account_id: account_id.clone(),
            side: side.to_string(),
            near_amount,
            token_amount,
            price: market.price,
            timestamp: env::block_timestamp(),
        };
        self.history.insert(&id, &trade);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn account(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn context(predecessor: &str, deposit: u128) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(account("market.testnet"))
            .signer_account_id(account(predecessor))
            .predecessor_account_id(account(predecessor))
            .account_balance(NearToken::from_near(100))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(1_700_000_000_000_000_000);
        builder
    }

    fn market_contract(owner: &str) -> Contract {
        testing_env!(context(owner, 0).build());
        Contract::new(account(owner))
    }

    fn create(contract: &mut Contract, owner: &str) {
        testing_env!(context(owner, 0).build());
        contract.create_market(
            "tok_1".to_string(),
            "owner/repo".to_string(),
            "TEST".to_string(),
            Some(account("creator.testnet")),
            U128(1_000_000),
            U128(500_000),
            U128(10_000),
            U128(50),
            U128(100_000),
        );
    }

    #[test]
    fn creates_market_with_a_capped_step() {
        let mut contract = market_contract("owner.testnet");
        create(&mut contract, "owner.testnet");
        let market = contract.get_market("tok_1".to_string()).unwrap();
        assert_eq!(market.price, 10_000);
        assert_eq!(market.step, 50);
        assert_eq!(market.max_wallet, 100_000);
        assert_eq!(market.reserve, 0);
    }

    #[test]
    #[should_panic(expected = "step too large")]
    fn rejects_an_arbitrageable_step() {
        let mut contract = market_contract("owner.testnet");
        testing_env!(context("owner.testnet", 0).build());
        contract.create_market(
            "tok_1".to_string(),
            "owner/repo".to_string(),
            "TEST".to_string(),
            Some(account("creator.testnet")),
            U128(1_000_000),
            U128(500_000),
            U128(10_000),
            U128(100),
            U128(0),
        );
    }

    #[test]
    fn buy_moves_price_and_tracks_balance_fees() {
        let mut contract = market_contract("owner.testnet");
        create(&mut contract, "owner.testnet");

        testing_env!(context("buyer.testnet", 1_000_000).build());
        let tokens = contract.buy("tok_1".to_string(), None).0;
        assert_eq!(tokens, 98);
        let market = contract.get_market("tok_1".to_string()).unwrap();
        assert_eq!(market.price, 10_050);
        assert_eq!(market.reserve, 987_000);
        assert_eq!(
            contract.get_balance("tok_1".to_string(), account("buyer.testnet")).0,
            98
        );
        assert_eq!(contract.get_trades("tok_1".to_string(), None).len(), 1);
        assert!(contract.get_platform_fees().0 > 0);
        assert!(contract.get_dev_fees("tok_1".to_string()).0 > 0);
    }

    #[test]
    #[should_panic(expected = "wallet holding cap reached")]
    fn rejects_a_buy_above_the_wallet_cap() {
        let mut contract = market_contract("owner.testnet");
        testing_env!(context("owner.testnet", 0).build());
        contract.create_market(
            "tok_1".to_string(),
            "owner/repo".to_string(),
            "TEST".to_string(),
            Some(account("creator.testnet")),
            U128(1_000_000),
            U128(500_000),
            U128(10_000),
            U128(50),
            U128(100),
        );
        testing_env!(context("buyer.testnet", 2_000_000).build());
        contract.buy("tok_1".to_string(), None);
    }

    #[test]
    fn sells_after_graduation() {
        let mut contract = market_contract("owner.testnet");
        create(&mut contract, "owner.testnet");
        let key = balance_key("tok_1", &account("seller.testnet"));
        let mut market = contract.get_market("tok_1".to_string()).unwrap();
        market.status = "graduated".to_string();
        market.reserve = 20_000_000;
        contract.markets.insert(&"tok_1".to_string(), &market);
        contract.balances.insert(&key, &1_000);
        contract.costs.insert(&key, &1_000);
        testing_env!(context("seller.testnet", 0).build());
        let _ = contract.sell("tok_1".to_string(), U128(1_000), Some(U128(1)));
        assert_eq!(
            contract.get_balance("tok_1".to_string(), account("seller.testnet")).0,
            0
        );
    }

    #[test]
    #[should_panic(expected = "buying is paused")]
    fn paused_buy_reverts() {
        let mut contract = market_contract("owner.testnet");
        create(&mut contract, "owner.testnet");
        contract.set_paused(true);
        testing_env!(context("buyer.testnet", 1_000_000).build());
        contract.buy("tok_1".to_string(), None);
    }

    #[test]
    fn two_step_owner_transfer() {
        let mut contract = market_contract("owner.testnet");
        contract.propose_owner(account("next.testnet"));
        testing_env!(context("next.testnet", 0).build());
        contract.accept_owner();
        assert_eq!(contract.owner_id, account("next.testnet"));
        assert!(contract.pending_owner.is_none());
    }
}
