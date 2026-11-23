//! Reads MagicBlock's pricing oracle (Pyth Lazer SOL/USD republished on the rollup).

use crate::TipoffError;
use anchor_lang::prelude::*;

pub const ORACLE_PROGRAM: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
/// PDA `["price_feed", "pyth-lazer", "6"]` under the oracle program.
pub const SOL_USD_FEED: Pubkey = pubkey!("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
pub const MAX_AGE_SECS: i64 = 30;

#[derive(AnchorDeserialize)]
enum VerificationLevel {
    Partial { _num_signatures: u8 },
    Full,
}

/// Field layout of the oracle's `PriceUpdateV3` account after its 8-byte discriminator.
#[derive(AnchorDeserialize)]
struct PriceUpdate {
    _write_authority: Pubkey,
    _verification_level: VerificationLevel,
    feed_id: [u8; 32],
    price: i64,
    _conf: u64,
    _exponent: i32,
    publish_time: i64,
    _prev_publish_time: i64,
    _ema_price: i64,
    _ema_conf: u64,
    posted_slot: u64,
}

/// SOL/USD with 8 decimals. The exponent comes from the Lazer feed list (-8), because the
/// value stored in the account is wrong.
pub fn read_price(feed: &AccountInfo, now: i64) -> Result<i64> {
    require_keys_eq!(feed.key(), SOL_USD_FEED, TipoffError::BadPrice);
    require_keys_eq!(*feed.owner, ORACLE_PROGRAM, TipoffError::BadPrice);
    let data = feed.try_borrow_data()?;
    require!(data.len() > 8, TipoffError::BadPrice);
    let u = PriceUpdate::deserialize(&mut &data[8..]).map_err(|_| TipoffError::BadPrice)?;
    require!(u.feed_id == SOL_USD_FEED.to_bytes(), TipoffError::BadPrice);
    require!(u.posted_slot > 0 && u.price > 0, TipoffError::BadPrice);
    require!((now - u.publish_time).abs() <= MAX_AGE_SECS, TipoffError::BadPrice);
    Ok(u.price)
}
