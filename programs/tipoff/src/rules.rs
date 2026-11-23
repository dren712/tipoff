//! Game rules as pure functions, so they can be tested without a validator and re-run by
//! anyone to verify a settled round.

use crate::state::*;
use crate::TipoffError;
use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

pub const ROUND_SECS: i64 = 60;
pub const VOTE_SECS: i64 = 15;
pub const VRF_RETRY_SECS: i64 = 20;
pub const MAX_POS: i8 = 5;
/// One lot is 1,000 chips of exposure at the opening price.
pub const LOT: i64 = 1_000_000_000;
pub const ACCUSE_WIN: i64 = 100_000_000;
pub const ACCUSE_LOSS: i64 = 50_000_000;
pub const CAUGHT_FINE: i64 = 100_000_000;

pub struct Draw {
    pub insider: u8,
    pub shocks: [Shock; SHOCKS],
}

/// Derives the insider and the shocks from the hidden salt. One shock lands in each
/// 12-second window from 8 s to 56 s, moving the price 0.8% to 2.5% up or down.
pub fn draw_round(salt: &[u8; 32]) -> Draw {
    let h = hashv(&[b"tipoff-draw", &salt[..]]).to_bytes();
    let mut shocks = [Shock::default(); SHOCKS];
    for (i, s) in shocks.iter_mut().enumerate() {
        let b = &h[1 + i * 4..5 + i * 4];
        let size = 80 + (u16::from_le_bytes([b[1], b[2]]) % 171) as i16;
        s.at = 8 + (i as u8) * 12 + b[0] % 12;
        s.bps = if b[3] & 1 == 0 { size } else { -size };
    }
    Draw { insider: h[0] % SEATS as u8, shocks }
}

pub fn shocked(oracle_price: i64, bps: i32) -> Result<i64> {
    let p = (oracle_price as i128) * (10_000 + bps as i128) / 10_000;
    i64::try_from(p).map_err(|_| TipoffError::Overflow.into())
}

fn lots_value(lots: i64, price: i64, open: i64) -> Result<i64> {
    require!(open > 0, TipoffError::BadPrice);
    let v = (lots as i128) * (LOT as i128) * (price as i128) / (open as i128);
    i64::try_from(v).map_err(|_| TipoffError::Overflow.into())
}

pub fn apply_trade(seat: &mut Seat, delta: i8, price: i64, open: i64) -> Result<()> {
    let pos = seat.pos.checked_add(delta).ok_or(TipoffError::PositionLimit)?;
    require!(delta != 0 && pos.abs() <= MAX_POS, TipoffError::PositionLimit);
    seat.cash = seat
        .cash
        .checked_sub(lots_value(delta as i64, price, open)?)
        .ok_or(TipoffError::Overflow)?;
    seat.pos = pos;
    seat.trades = seat.trades.saturating_add(1);
    Ok(())
}

/// Chips won or lost this round with the position marked at `price`.
pub fn equity(seat: &Seat, price: i64, open: i64) -> Result<i64> {
    seat.cash
        .checked_add(lots_value(seat.pos as i64, price, open)?)
        .ok_or(TipoffError::Overflow.into())
}

pub struct Outcome {
    pub caught: bool,
    pub scores: [i64; SEATS],
}

/// The insider is caught when they hold the most votes outright, with at least two.
/// Caught: their profit is split between the correct accusers and they pay a fine.
/// Not caught: their profit doubles. Accusers gain or lose a fixed stake on their vote.
pub fn score_round(insider: u8, votes: &[u8; SEATS], pnl: &[i64; SEATS]) -> Outcome {
    let k = insider as usize;
    let mut tally = [0u8; SEATS];
    for (i, v) in votes.iter().enumerate() {
        if i != k && (*v as usize) < SEATS {
            tally[*v as usize] += 1;
        }
    }
    let caught = tally[k] >= 2 && tally.iter().enumerate().all(|(i, n)| i == k || *n < tally[k]);
    let mut scores = *pnl;
    let correct = tally[k] as i64;
    for i in 0..SEATS {
        if i == k {
            continue;
        }
        if votes[i] == insider {
            scores[i] = scores[i].saturating_add(ACCUSE_WIN);
        } else if (votes[i] as usize) < SEATS {
            scores[i] = scores[i].saturating_sub(ACCUSE_LOSS);
        }
    }
    let profit = pnl[k].max(0);
    if caught {
        scores[k] = pnl[k].min(0).saturating_sub(CAUGHT_FINE);
        for i in 0..SEATS {
            if i != k && votes[i] == insider {
                scores[i] = scores[i].saturating_add(profit / correct);
            }
        }
    } else {
        scores[k] = pnl[k].saturating_add(profit);
    }
    Outcome { caught, scores }
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: i64 = 150_00000000;

    #[test]
    fn draw_is_deterministic_and_in_range() {
        for n in 0u32..500 {
            let salt = hashv(&[&n.to_le_bytes()]).to_bytes();
            let d = draw_round(&salt);
            assert_eq!(d.shocks, draw_round(&salt).shocks);
            assert!((d.insider as usize) < SEATS);
            for (i, s) in d.shocks.iter().enumerate() {
                assert!(s.at as i64 >= 8 + 12 * i as i64 && (s.at as i64) < 20 + 12 * i as i64);
                assert!((s.at as i64) < ROUND_SECS);
                assert!(s.bps.abs() >= 80 && s.bps.abs() <= 250);
            }
        }
    }

    #[test]
    fn draw_covers_every_seat_and_both_directions() {
        let (mut seats, mut up, mut down) = ([0u32; SEATS], 0, 0);
        for n in 0u32..600 {
            let d = draw_round(&hashv(&[&n.to_le_bytes()]).to_bytes());
            seats[d.insider as usize] += 1;
            d.shocks.iter().for_each(|s| if s.bps > 0 { up += 1 } else { down += 1 });
        }
        assert!(seats.iter().all(|n| *n > 60));
        assert!(up > 1000 && down > 1000);
    }

    #[test]
    fn round_trip_trade_at_one_price_is_flat() {
        let mut s = Seat::default();
        apply_trade(&mut s, 3, P, P).unwrap();
        apply_trade(&mut s, -3, P, P).unwrap();
        assert_eq!((s.pos, s.cash, s.trades), (0, 0, 2));
    }

    #[test]
    fn long_gains_and_short_loses_on_a_rise() {
        let up = shocked(P, 200).unwrap();
        let mut long = Seat::default();
        apply_trade(&mut long, 5, P, P).unwrap();
        assert_eq!(equity(&long, up, P).unwrap(), 5 * LOT * 2 / 100);
        let mut short = Seat::default();
        apply_trade(&mut short, -5, P, P).unwrap();
        assert_eq!(equity(&short, up, P).unwrap(), -5 * LOT * 2 / 100);
    }

    #[test]
    fn position_limit_and_zero_delta_rejected() {
        let mut s = Seat::default();
        assert!(apply_trade(&mut s, 0, P, P).is_err());
        assert!(apply_trade(&mut s, 6, P, P).is_err());
        apply_trade(&mut s, 5, P, P).unwrap();
        assert!(apply_trade(&mut s, 1, P, P).is_err());
        assert!(apply_trade(&mut s, i8::MAX, P, P).is_err());
        apply_trade(&mut s, -10, P, P).unwrap();
        assert_eq!(s.pos, -5);
    }

    #[test]
    fn uncaught_insider_doubles_profit() {
        let pnl = [300, 0, 0, 0, 0, 0];
        let o = score_round(0, &[NONE, 2, 2, 0, NONE, NONE], &pnl);
        assert!(!o.caught);
        assert_eq!(o.scores[0], 600);
        assert_eq!(o.scores[3], ACCUSE_WIN);
        assert_eq!(o.scores[1], -ACCUSE_LOSS);
        assert_eq!(o.scores[4], 0);
    }

    #[test]
    fn caught_insider_forfeits_profit_to_accusers() {
        let pnl = [900, 10, 0, 0, 0, 0];
        let o = score_round(0, &[1, 0, 0, 0, 2, NONE], &pnl);
        assert!(o.caught);
        assert_eq!(o.scores[0], -CAUGHT_FINE);
        assert_eq!(o.scores[1], 10 + ACCUSE_WIN + 300);
        assert_eq!(o.scores[4], -ACCUSE_LOSS);
    }

    #[test]
    fn tie_for_most_votes_is_not_caught_and_own_vote_is_ignored() {
        let o = score_round(0, &[0, 0, 0, 1, 1, NONE], &[0; SEATS]);
        assert!(!o.caught);
        // The insider voting for themselves must not count.
        let o = score_round(0, &[0, 0, NONE, NONE, NONE, NONE], &[0; SEATS]);
        assert!(!o.caught);
    }

    #[test]
    fn caught_insider_keeps_losses() {
        let o = score_round(2, &[2, 2, NONE, 2, NONE, NONE], &[0, 0, -500, 0, 0, 0]);
        assert!(o.caught);
        assert_eq!(o.scores[2], -500 - CAUGHT_FINE);
        assert_eq!(o.scores[0], ACCUSE_WIN);
    }
}
