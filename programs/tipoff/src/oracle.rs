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

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn feed_data(feed_id: [u8; 32], price: i64, publish_time: i64, posted_slot: u64) -> Vec<u8> {
        let mut d = vec![0u8; 8];
        d.extend_from_slice(&[7u8; 32]); // write authority
        d.push(1); // VerificationLevel::Full
        d.extend_from_slice(&feed_id);
        d.extend_from_slice(&price.to_le_bytes());
        d.extend_from_slice(&0u64.to_le_bytes());
        d.extend_from_slice(&8i32.to_le_bytes());
        d.extend_from_slice(&publish_time.to_le_bytes());
        d.extend_from_slice(&publish_time.to_le_bytes());
        d.extend_from_slice(&price.to_le_bytes());
        d.extend_from_slice(&0u64.to_le_bytes());
        d.extend_from_slice(&posted_slot.to_le_bytes());
        d
    }

    fn read(key: Pubkey, owner: Pubkey, mut data: Vec<u8>, now: i64) -> Result<i64> {
        let mut lamports = 1u64;
        let info = AccountInfo::new(&key, false, false, &mut lamports, &mut data, &owner, false);
        read_price(&info, now)
    }

    fn good() -> Vec<u8> {
        feed_data(SOL_USD_FEED.to_bytes(), 150_00000000, NOW - 2, 99)
    }

    #[test]
    fn reads_a_fresh_price() {
        assert_eq!(read(SOL_USD_FEED, ORACLE_PROGRAM, good(), NOW).unwrap(), 150_00000000);
    }

    #[test]
    fn rejects_another_account_or_owner() {
        assert!(read(Pubkey::new_unique(), ORACLE_PROGRAM, good(), NOW).is_err());
        assert!(read(SOL_USD_FEED, Pubkey::new_unique(), good(), NOW).is_err());
    }

    #[test]
    fn rejects_wrong_feed_id() {
        assert!(read(SOL_USD_FEED, ORACLE_PROGRAM, feed_data([1; 32], 150_00000000, NOW, 99), NOW).is_err());
    }

    #[test]
    fn rejects_zero_negative_and_unposted_prices() {
        let id = SOL_USD_FEED.to_bytes();
        assert!(read(SOL_USD_FEED, ORACLE_PROGRAM, feed_data(id, 0, NOW, 99), NOW).is_err());
        assert!(read(SOL_USD_FEED, ORACLE_PROGRAM, feed_data(id, -5, NOW, 99), NOW).is_err());
        assert!(read(SOL_USD_FEED, ORACLE_PROGRAM, feed_data(id, 5, NOW, 0), NOW).is_err());
    }

    #[test]
    fn rejects_stale_and_future_prices() {
        let id = SOL_USD_FEED.to_bytes();
        assert!(read(SOL_USD_FEED, ORACLE_PROGRAM, feed_data(id, 5, NOW - MAX_AGE_SECS, 9), NOW).is_ok());
        assert!(read(SOL_USD_FEED, ORACLE_PROGRAM, feed_data(id, 5, NOW - MAX_AGE_SECS - 1, 9), NOW).is_err());
        assert!(read(SOL_USD_FEED, ORACLE_PROGRAM, feed_data(id, 5, NOW + MAX_AGE_SECS + 1, 9), NOW).is_err());
    }

    #[test]
    fn rejects_empty_and_truncated_data() {
        assert!(read(SOL_USD_FEED, ORACLE_PROGRAM, vec![], NOW).is_err());
        assert!(read(SOL_USD_FEED, ORACLE_PROGRAM, good()[..60].to_vec(), NOW).is_err());
    }
}
