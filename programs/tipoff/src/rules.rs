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
pub const ALLIN_WIN: i64 = 200_000_000;
pub const ALLIN_LOSS: i64 = 150_000_000;
pub const CAUGHT_FINE: i64 = 100_000_000;
pub const BLOWN_TIP: i64 = 50_000_000;
pub const RUMOUR_LEAD: i64 = 5;
pub const CONVICTION: u8 = 8;
pub const LEVERAGE: i64 = 12;
pub const MAX_SWING_BPS: i64 = 600;

pub struct Draw {
    pub insider: u8,
    pub shocks: [Shock; SHOCKS],
    pub rumours: [i8; SHOCKS],
}

/// Derives the insider, shocks, and rumours from the hidden salt. One shock lands in each
/// 12-second window from 8 s to 56 s: windows 1-2 move 0.8% to 2.5%, window 3 moves
/// 1.2% to 3.75% (1.5x), and window 4 moves 1.6% to 5.0% (2x), up or down. Each rumour
/// matches the true shock direction when `h[17 + i] % 3 != 0` (~2/3 of the time).
pub fn draw_round(salt: &[u8; 32]) -> Draw {
    let h = hashv(&[b"tipoff-draw", &salt[..]]).to_bytes();
    let mut shocks = [Shock::default(); SHOCKS];
    let mut rumours = [0i8; SHOCKS];
    for (i, s) in shocks.iter_mut().enumerate() {
        let b = &h[1 + i * 4..5 + i * 4];
        let raw = 80 + (u16::from_le_bytes([b[1], b[2]]) % 171) as i16;
        let size = match i {
            2 => raw * 3 / 2,
            3 => raw * 2,
            _ => raw,
        };
        s.at = 8 + (i as u8) * 12 + b[0] % 12;
        s.bps = if b[3] & 1 == 0 { size } else { -size };
        let dir = if s.bps > 0 { 1i8 } else { -1i8 };
        rumours[i] = if h[17 + i] % 3 != 0 { dir } else { -dir };
    }
    Draw { insider: h[0] % SEATS as u8, shocks, rumours }
}

/// Applies the `LEVERAGE`x oracle move from `open_price`, clamped to `+-MAX_SWING_BPS`.
pub fn levered(oracle_price: i64, open_price: i64) -> Result<i64> {
    require!(open_price > 0, TipoffError::BadPrice);
    let open = open_price as i128;
    let move_bps = ((oracle_price as i128) - open) * 10_000 / open;
    let swung_bps =
        (move_bps * (LEVERAGE as i128)).clamp(-(MAX_SWING_BPS as i128), MAX_SWING_BPS as i128);
    shocked(open_price, swung_bps as i32)
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
    require!(delta != 0 && (-MAX_POS..=MAX_POS).contains(&pos), TipoffError::PositionLimit);
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

/// Decodes a vote byte into `(seat, is_all_in)`.
/// `0..SEATS` are normal accusations; `CONVICTION..CONVICTION+SEATS` are all-in; all others are no vote.
pub fn decode_vote(v: u8) -> Option<(u8, bool)> {
    if (v as usize) < SEATS {
        Some((v, false))
    } else if v >= CONVICTION && ((v - CONVICTION) as usize) < SEATS {
        Some((v - CONVICTION, true))
    } else {
        None
    }
}

/// The insider is caught when they hold the most votes outright, with at least two.
/// Caught: their profit is split between the correct accusers and they pay a fine.
/// Not caught: positive profit doubles; zero or negative profit incurs `BLOWN_TIP`.
/// Accusers gain or lose a fixed stake based on normal vs all-in (`CONVICTION`) vote.
pub fn score_round(insider: u8, votes: &[u8; SEATS], pnl: &[i64; SEATS]) -> Outcome {
    let k = insider as usize;
    let mut tally = [0u8; SEATS];
    for (i, v) in votes.iter().enumerate() {
        if i != k {
            if let Some((target, _)) = decode_vote(*v) {
                tally[target as usize] += 1;
            }
        }
    }
    let caught = tally[k] >= 2 && tally.iter().enumerate().all(|(i, n)| i == k || *n < tally[k]);
    let mut scores = *pnl;
    let correct = tally[k] as i64;
    for i in 0..SEATS {
        if i == k {
            continue;
        }
        let Some((target, all_in)) = decode_vote(votes[i]) else {
            continue;
        };
        if target == insider {
            scores[i] = scores[i].saturating_add(if all_in { ALLIN_WIN } else { ACCUSE_WIN });
        } else {
            scores[i] = scores[i].saturating_sub(if all_in { ALLIN_LOSS } else { ACCUSE_LOSS });
        }
    }
    let profit = pnl[k].max(0);
    if caught {
        scores[k] = pnl[k].min(0).saturating_sub(CAUGHT_FINE);
        for i in 0..SEATS {
            if i != k && matches!(decode_vote(votes[i]), Some((t, _)) if t == insider) {
                scores[i] = scores[i].saturating_add(profit / correct);
            }
        }
    } else if pnl[k] > 0 {
        scores[k] = pnl[k].saturating_add(profit);
    } else {
        scores[k] = pnl[k].saturating_sub(BLOWN_TIP);
    }
    Outcome { caught, scores }
}

fn apply_board_entry(entry: &mut Entry, table: &Table, seat_idx: usize) {
    let seat = &table.seats[seat_idx];
    entry.score = entry.score.saturating_add(seat.last);
    entry.rounds = entry.rounds.saturating_add(1);
    match decode_vote(table.votes[seat_idx]) {
        Some((target, _)) if target == table.insider => {
            entry.caught = entry.caught.saturating_add(1);
            entry.streak = entry.streak.saturating_add(1);
            entry.best = entry.best.max(entry.streak);
        }
        Some(_) => entry.streak = 0,
        None => {}
    }
    if seat_idx as u8 == table.insider && !table.caught {
        entry.escapes = entry.escapes.saturating_add(1);
    }
}

/// Records all masked-in human seats from a settled `table` onto `board`.
pub fn post_board_round(board: &mut Board, table: &Table, mask: u8) -> Result<()> {
    require!(table.phase == Phase::Settled as u8, TipoffError::WrongPhase);
    let slot = (table.id % BOARD_TABLES as u64) as usize;
    require!(board.posted[slot] < table.round, TipoffError::AlreadyPosted);
    board.posted[slot] = table.round;

    for (i, seat) in table.seats.iter().enumerate() {
        if (mask & (1u8 << i)) == 0 || seat.player == Pubkey::default() {
            continue;
        }
        if let Some(pos) = board.entries.iter().position(|e| e.player == seat.player) {
            apply_board_entry(&mut board.entries[pos], table, i);
        } else {
            let mut candidate = Entry { player: seat.player, ..Entry::default() };
            apply_board_entry(&mut candidate, table, i);
            if let Some(empty) = board.entries.iter().position(|e| e.player == Pubkey::default()) {
                board.entries[empty] = candidate;
            } else if let Some((min_idx, min_entry)) =
                board.entries.iter().enumerate().min_by_key(|(_, e)| e.score)
            {
                if candidate.score > min_entry.score {
                    board.entries[min_idx] = candidate;
                }
            }
        }
    }
    Ok(())
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
                let bounds = match i {
                    2 => 120..=375,
                    3 => 160..=500,
                    _ => 80..=250,
                };
                assert!(bounds.contains(&s.bps.abs()), "window {i} bps {}", s.bps);
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

    fn assert_tipoff_err<T: core::fmt::Debug>(res: Result<T>, expected: TipoffError) {
        let err = res.expect_err("expected error");
        assert_eq!(err, anchor_lang::error::Error::from(expected));
    }

    #[test]
    fn lots_value_private_branches() {
        // Zero lots always yields zero for any valid open price.
        assert_eq!(lots_value(0, P, P).unwrap(), 0);
        assert_eq!(lots_value(0, i64::MAX, 1).unwrap(), 0);

        // Non-positive open price returns BadPrice.
        assert_tipoff_err(lots_value(1, P, 0), TipoffError::BadPrice);
        assert_tipoff_err(lots_value(1, P, -1), TipoffError::BadPrice);
        assert_tipoff_err(lots_value(-1, P, i64::MIN), TipoffError::BadPrice);

        // Exact scaling and truncation toward zero for positive and negative lots.
        assert_eq!(lots_value(2, P, P).unwrap(), 2 * LOT);
        assert_eq!(lots_value(-2, P, P).unwrap(), -2 * LOT);
        assert_eq!(lots_value(1, 3, 2).unwrap(), LOT * 3 / 2);
        assert_eq!(lots_value(1, 1, 3).unwrap(), LOT / 3);
        assert_eq!(lots_value(-1, 1, 3).unwrap(), -(LOT / 3));

        // Overflow when converting i128 result to i64 returns Overflow.
        assert_tipoff_err(lots_value(1, i64::MAX, 1), TipoffError::Overflow);
        assert_tipoff_err(lots_value(-1, i64::MAX, 1), TipoffError::Overflow);
        assert_tipoff_err(lots_value(5, i64::MAX, LOT), TipoffError::Overflow);
    }

    #[test]
    fn apply_trade_exact_boundaries_and_stepwise_limits() {
        let mut s = Seat::default();
        // Step +1 five times to reach +5.
        for expected in 1..=MAX_POS {
            apply_trade(&mut s, 1, P, P).unwrap();
            assert_eq!(s.pos, expected);
        }
        assert_eq!(s.trades, 5);
        assert_eq!(s.cash, -5 * LOT);

        // +1 from +5 exceeds MAX_POS; seat must remain unchanged.
        let snapshot = (s.pos, s.cash, s.trades);
        assert_tipoff_err(apply_trade(&mut s, 1, P, P), TipoffError::PositionLimit);
        assert_eq!((s.pos, s.cash, s.trades), snapshot);

        // Step -1 ten times to flip from +5 to -5.
        for k in 1..=10 {
            apply_trade(&mut s, -1, P, P).unwrap();
            assert_eq!(s.pos, MAX_POS - k);
        }
        assert_eq!(s.pos, -MAX_POS);
        assert_eq!(s.cash, 5 * LOT);
        assert_eq!(s.trades, 15);

        // -1 from -5 exceeds -MAX_POS; seat must remain unchanged.
        let snapshot = (s.pos, s.cash, s.trades);
        assert_tipoff_err(apply_trade(&mut s, -1, P, P), TipoffError::PositionLimit);
        assert_eq!((s.pos, s.cash, s.trades), snapshot);

        // Jump -5 -> +5 (+10) succeeds, while +11 from -5 or -11 from +5 fails.
        assert_tipoff_err(apply_trade(&mut s, 11, P, P), TipoffError::PositionLimit);
        apply_trade(&mut s, 10, P, P).unwrap();
        assert_eq!(s.pos, MAX_POS);
        assert_tipoff_err(apply_trade(&mut s, -11, P, P), TipoffError::PositionLimit);
    }

    #[test]
    fn apply_trade_zero_delta_and_overflow_branches() {
        // Zero delta rejected at 0, +5, and -5 without mutating seat.
        for start_pos in [0i8, MAX_POS, -MAX_POS] {
            let mut s = Seat { pos: start_pos, cash: 42, trades: 7, ..Default::default() };
            assert_tipoff_err(apply_trade(&mut s, 0, P, P), TipoffError::PositionLimit);
            assert_eq!((s.pos, s.cash, s.trades), (start_pos, 42, 7));
        }

        // i8 checked_add overflows at positive and negative extremes return PositionLimit.
        let mut high = Seat { pos: MAX_POS, ..Default::default() };
        assert_tipoff_err(apply_trade(&mut high, i8::MAX, P, P), TipoffError::PositionLimit);
        assert_tipoff_err(apply_trade(&mut high, 123, P, P), TipoffError::PositionLimit);

        let mut low = Seat { pos: -1, ..Default::default() };
        assert_tipoff_err(apply_trade(&mut low, i8::MIN, P, P), TipoffError::PositionLimit);
        let mut min_edge = Seat { pos: -MAX_POS, ..Default::default() };
        assert_tipoff_err(apply_trade(&mut min_edge, -124, P, P), TipoffError::PositionLimit);

        // Cash checked_sub overflow returns Overflow without mutating seat.
        let mut cash_low = Seat { cash: i64::MIN, ..Default::default() };
        assert_tipoff_err(apply_trade(&mut cash_low, 1, P, P), TipoffError::Overflow);
        assert_eq!((cash_low.pos, cash_low.cash, cash_low.trades), (0, i64::MIN, 0));

        let mut cash_high = Seat { cash: i64::MAX, ..Default::default() };
        assert_tipoff_err(apply_trade(&mut cash_high, -1, P, P), TipoffError::Overflow);
        assert_eq!((cash_high.pos, cash_high.cash, cash_high.trades), (0, i64::MAX, 0));

        // Bad open price or lots_value overflow propagates properly.
        let mut s = Seat::default();
        assert_tipoff_err(apply_trade(&mut s, 1, P, 0), TipoffError::BadPrice);
        assert_tipoff_err(apply_trade(&mut s, 1, i64::MAX, 1), TipoffError::Overflow);

        // Trade count saturates at u16::MAX rather than wrapping.
        let mut max_trades = Seat { trades: u16::MAX, ..Default::default() };
        apply_trade(&mut max_trades, 1, P, P).unwrap();
        assert_eq!(max_trades.trades, u16::MAX);
    }

    // Suspected bug: `pos.abs()` on line 51 panics (`attempt to negate with overflow`) when
    // `seat.pos + delta == i8::MIN` (`-128`), instead of returning `Err(TipoffError::PositionLimit)`.
    
    #[test]
    fn apply_trade_i8_min_is_position_limit() {
        let mut s = Seat::default();
        assert_tipoff_err(apply_trade(&mut s, i8::MIN, P, P), TipoffError::PositionLimit);
    }

    #[test]
    fn shocked_branches_and_overflow() {
        assert_eq!(shocked(P, 0).unwrap(), P);
        assert_eq!(shocked(P, 250).unwrap(), 153_75000000);
        assert_eq!(shocked(P, -250).unwrap(), 146_25000000);
        assert_eq!(shocked(P, 10_000).unwrap(), 2 * P);
        assert_eq!(shocked(P, -10_000).unwrap(), 0);
        // Integer division truncates toward zero.
        assert_eq!(shocked(1, 250).unwrap(), 1);
        assert_eq!(shocked(1, -250).unwrap(), 0);
        // Overflow returns TipoffError::Overflow.
        assert_tipoff_err(shocked(i64::MAX, 1), TipoffError::Overflow);
        assert_tipoff_err(shocked(i64::MIN, 1), TipoffError::Overflow);
    }

    #[test]
    fn equity_branches_and_overflow() {
        // Flat seat always equals cash regardless of current price.
        let flat = Seat { pos: 0, cash: -123_456, ..Default::default() };
        assert_eq!(equity(&flat, P * 3, P).unwrap(), -123_456);

        // Short gains when price drops and loses when price rises.
        let down = shocked(P, -200).unwrap();
        let mut short = Seat::default();
        apply_trade(&mut short, -4, P, P).unwrap();
        assert_eq!(equity(&short, down, P).unwrap(), 4 * LOT * 2 / 100);
        // Closing at `down` makes realized cash equal prior mark-to-market equity.
        let expected_cash = equity(&short, down, P).unwrap();
        apply_trade(&mut short, 4, down, P).unwrap();
        assert_eq!(short.pos, 0);
        assert_eq!(short.cash, expected_cash);

        // Bad open price and cash+lots_value overflow.
        assert_tipoff_err(equity(&flat, P, 0), TipoffError::BadPrice);
        let max_cash = Seat { pos: 1, cash: i64::MAX, ..Default::default() };
        assert_tipoff_err(equity(&max_cash, P, P), TipoffError::Overflow);
        let min_cash = Seat { pos: -1, cash: i64::MIN, ..Default::default() };
        assert_tipoff_err(equity(&min_cash, P, P), TipoffError::Overflow);
    }

    #[test]
    fn score_round_edge_cases_and_ties() {
        // Nobody votes: insider doubles positive profit, keeps negative profit; traders keep PnL.
        let pnl = [500, 100, -200, 0, 50, -50];
        let o = score_round(0, &[NONE; SEATS], &pnl);
        assert!(!o.caught);
        assert_eq!(o.scores, [1000, 100, -200, 0, 50, -50]);

        let neg_pnl = [-500, 100, -200, 0, 50, -50];
        let o_neg = score_round(0, &[NONE; SEATS], &neg_pnl);
        assert!(!o_neg.caught);
        assert_eq!(o_neg.scores, [-500 - BLOWN_TIP, 100, -200, 0, 50, -50]);

        // Everyone votes for the insider (all 5 non-insiders): caught, profit split 5 ways.
        let pnl_all = [10, 20, 1_000_000, 30, 40, 50];
        let o_all = score_round(2, &[2, 2, 1, 2, 2, 2], &pnl_all);
        assert!(o_all.caught);
        assert_eq!(o_all.scores[2], -CAUGHT_FINE);
        let share = 1_000_000 / 5;
        assert_eq!(o_all.scores[0], 10 + ACCUSE_WIN + share);
        assert_eq!(o_all.scores[1], 20 + ACCUSE_WIN + share);
        assert_eq!(o_all.scores[3], 30 + ACCUSE_WIN + share);
        assert_eq!(o_all.scores[4], 40 + ACCUSE_WIN + share);
        assert_eq!(o_all.scores[5], 50 + ACCUSE_WIN + share);

        // Two-way tie (2 vs 2) and five-way tie (1 each) do not catch the insider.
        let tie_2_2_1 = score_round(0, &[NONE, 0, 0, 1, 1, 2], &[400; SEATS]);
        assert!(!tie_2_2_1.caught);
        assert_eq!(tie_2_2_1.scores[0], 800);

        let tie_ones = score_round(0, &[NONE, 0, 1, 2, 3, 4], &[400; SEATS]);
        assert!(!tie_ones.caught);

        // 3 votes for insider vs 2 votes for seat 1: insider cannot force a 3-3 tie with own vote.
        let insider_votes_decoy = score_round(0, &[1, 0, 0, 0, 1, 1], &[600, 0, 0, 0, 0, 0]);
        assert!(insider_votes_decoy.caught);
        assert_eq!(insider_votes_decoy.scores[0], -CAUGHT_FINE);
        assert_eq!(insider_votes_decoy.scores[1], ACCUSE_WIN + 200);
        assert_eq!(insider_votes_decoy.scores[4], -ACCUSE_LOSS);

        // 2 votes for insider while other 3 traders split across 3 different seats: caught.
        let plurality_2 = score_round(5, &[5, 5, 0, 1, 2, NONE], &[200, 0, 0, 0, 0, 100]);
        assert!(plurality_2.caught);
        assert_eq!(plurality_2.scores[5], -CAUGHT_FINE);
        assert_eq!(plurality_2.scores[0], 200 + ACCUSE_WIN + 50);

        // Non-NONE out-of-range vote values (>= SEATS) are treated as no vote.
        let oob_vote = score_round(0, &[NONE, 6, 254, 255, 0, 0], &[100, 0, 0, 0, 0, 0]);
        assert!(oob_vote.caught);
        assert_eq!(oob_vote.scores[1], 0);
        assert_eq!(oob_vote.scores[2], 0);
        assert_eq!(oob_vote.scores[3], 0);
    }

    #[test]
    fn score_round_split_rounding_and_conservation() {
        // 10 microchips split among 3 accusers drops 1 microchip (integer truncation).
        let pnl = [10, 0, 0, 0, 0, 0];
        let votes = [NONE, 0, 0, 0, 1, NONE];
        let o = score_round(0, &votes, &pnl);
        assert!(o.caught);
        assert_eq!(o.scores[0], -CAUGHT_FINE);
        assert_eq!(o.scores[1], ACCUSE_WIN + 3);
        assert_eq!(o.scores[2], ACCUSE_WIN + 3);
        assert_eq!(o.scores[3], ACCUSE_WIN + 3);
        assert_eq!(o.scores[4], -ACCUSE_LOSS);
        assert_eq!(o.scores[5], 0);

        let sum_in: i64 = pnl.iter().sum();
        let sum_out: i64 = o.scores.iter().sum();
        let expected = sum_in - 10 - CAUGHT_FINE + 3 * ACCUSE_WIN - ACCUSE_LOSS + 3 * (10 / 3);
        assert_eq!(sum_out, expected);
        assert_eq!(sum_out - (sum_in - CAUGHT_FINE + 3 * ACCUSE_WIN - ACCUSE_LOSS), -1);

        // Escaped negative-profit insider: incurs BLOWN_TIP penalty plus vote stakes.
        let pnl2 = [-333, 50, -25, 0, 10, 90];
        let votes2 = [NONE, 0, 2, 3, NONE, NONE];
        let o2 = score_round(0, &votes2, &pnl2);
        assert!(!o2.caught);
        let sum2_in: i64 = pnl2.iter().sum();
        let sum2_out: i64 = o2.scores.iter().sum();
        assert_eq!(sum2_out, sum2_in - BLOWN_TIP + ACCUSE_WIN - 2 * ACCUSE_LOSS);

        // Zero-profit caught insider still pays fine; accusers get ACCUSE_WIN + 0.
        let o_zero = score_round(0, &[NONE, 0, 0, NONE, NONE, NONE], &[0; SEATS]);
        assert!(o_zero.caught);
        assert_eq!(o_zero.scores[0], -CAUGHT_FINE);
        assert_eq!(o_zero.scores[1], ACCUSE_WIN);
        assert_eq!(o_zero.scores[2], ACCUSE_WIN);

        // Split rounding across 2, 3, 4, and 5 accusers.
        for accusers in 2usize..=5 {
            let profit = 100_000_007i64;
            let mut pnl_split = [0i64; SEATS];
            pnl_split[0] = profit;
            let mut v = [NONE; SEATS];
            for slot in v.iter_mut().skip(1).take(accusers) {
                *slot = 0;
            }
            let out = score_round(0, &v, &pnl_split);
            assert!(out.caught);
            let share = profit / (accusers as i64);
            let remainder = profit % (accusers as i64);
            assert_eq!(out.scores[1], ACCUSE_WIN + share);
            let total: i64 = out.scores.iter().sum();
            assert_eq!(total, (accusers as i64) * ACCUSE_WIN - CAUGHT_FINE + (profit - remainder));
        }
    }

    #[test]
    fn apply_trade_direct_negative_limit_and_zero_price() {
        let mut s = Seat::default();
        assert_tipoff_err(apply_trade(&mut s, -6, P, P), TipoffError::PositionLimit);
        apply_trade(&mut s, -5, P, P).unwrap();
        assert_eq!(s.pos, -MAX_POS);
        apply_trade(&mut s, 5, P, P).unwrap();
        assert_eq!(s.pos, 0);

        // Zero price fills at zero cash delta without error when open > 0.
        apply_trade(&mut s, 1, 0, P).unwrap();
        assert_eq!((s.pos, s.cash, s.trades), (1, 0, 3));
    }

    #[test]
    fn score_round_symmetric_across_all_six_insider_seats() {
        for k in 0..SEATS {
            let mut pnl = [100i64; SEATS];
            pnl[k] = 1_000;
            let mut votes = [k as u8; SEATS];
            votes[k] = ((k + 1) % SEATS) as u8; // insider votes elsewhere; ignored
            let o = score_round(k as u8, &votes, &pnl);
            assert!(o.caught);
            assert_eq!(o.scores[k], -CAUGHT_FINE);
            for (i, &score) in o.scores.iter().enumerate() {
                if i != k {
                    assert_eq!(score, 100 + ACCUSE_WIN + 1_000 / 5);
                }
            }
        }
    }

    #[test]
    fn levered_move_clamping_and_bad_open() {
        // Unchanged oracle returns exact open price.
        assert_eq!(levered(P, P).unwrap(), P);

        // +0.10% oracle move scales 12x to +1.20% (+120 bps).
        let up_10bps = P + P / 1_000;
        assert_eq!(levered(up_10bps, P).unwrap(), shocked(P, 120).unwrap());
        assert_eq!(levered(100_10000000, 100_00000000).unwrap(), 101_20000000);

        // -0.10% oracle move scales 12x to -1.20% (-120 bps).
        let down_10bps = P - P / 1_000;
        assert_eq!(levered(down_10bps, P).unwrap(), shocked(P, -120).unwrap());

        // Clamp holds at +/-MAX_SWING_BPS (+/-600 bps) on both ends.
        let at_upper_edge = P * 10_050 / 10_000;
        let far_up = P * 12_000 / 10_000;
        assert_eq!(levered(at_upper_edge, P).unwrap(), shocked(P, MAX_SWING_BPS as i32).unwrap());
        assert_eq!(levered(far_up, P).unwrap(), shocked(P, MAX_SWING_BPS as i32).unwrap());

        let at_lower_edge = P * 9_950 / 10_000;
        let far_down = P * 8_000 / 10_000;
        assert_eq!(levered(at_lower_edge, P).unwrap(), shocked(P, -(MAX_SWING_BPS as i32)).unwrap());
        assert_eq!(levered(far_down, P).unwrap(), shocked(P, -(MAX_SWING_BPS as i32)).unwrap());

        // Non-positive open price returns BadPrice; overflow returns Overflow.
        assert_tipoff_err(levered(P, 0), TipoffError::BadPrice);
        assert_tipoff_err(levered(P, -1), TipoffError::BadPrice);
        assert_tipoff_err(levered(P, i64::MIN), TipoffError::BadPrice);
        assert_tipoff_err(levered(i64::MAX, i64::MAX - i64::MAX / 100), TipoffError::Overflow);
    }

    #[test]
    fn draw_matches_fixed_salt_test_vector() {
        // Must match app/src/chain.ts::redraw for the same 32-byte salt [0..32].
        let salt: [u8; 32] = core::array::from_fn(|i| i as u8);
        let d = draw_round(&salt);
        assert_eq!(d.insider, 0);
        assert_eq!(
            d.shocks,
            [
                Shock { at: 10, bps: 249 },
                Shock { at: 31, bps: -171 },
                Shock { at: 43, bps: -319 },
                Shock { at: 51, bps: -240 },
            ]
        );
    }

    #[test]
    fn rumours_are_deterministic_and_roughly_two_thirds_true() {
        let mut true_count = 0usize;
        let total_shocks = 3_000 * SHOCKS;
        for n in 0u32..3_000 {
            let salt = hashv(&[b"rumour-dist", &n.to_le_bytes()]).to_bytes();
            let d = draw_round(&salt);
            assert_eq!(d.rumours, draw_round(&salt).rumours);
            for i in 0..SHOCKS {
                assert!(d.rumours[i] == 1 || d.rumours[i] == -1);
                if d.rumours[i].signum() == (d.shocks[i].bps.signum() as i8) {
                    true_count += 1;
                }
            }
        }
        let pct = true_count * 100 / total_shocks;
        assert!((60..=73).contains(&pct), "true_count={true_count}/{total_shocks} ({pct}%)");
    }

    #[test]
    fn all_in_votes_and_invalid_vote_bytes() {
        // Votes 8..=13 map to seats 0..=5 all-in; 6, 7, 14, 254 are no vote.
        for s in 0..SEATS as u8 {
            assert_eq!(decode_vote(s), Some((s, false)));
            assert_eq!(decode_vote(CONVICTION + s), Some((s, true)));
        }
        for bad in [6u8, 7, 14, 254, NONE] {
            assert_eq!(decode_vote(bad), None);
        }

        // Insider is seat 0 (+900 pnl). Seats 1 (normal) and 2 (all-in) accuse 0 -> caught.
        // Seat 3 votes all-in wrong (seat 4 = 12), seat 4 votes invalid 6/7/14/254 checks.
        let pnl = [900, 10, 20, 30, 40, 50];
        let o = score_round(0, &[NONE, 0, CONVICTION, CONVICTION + 4, 6, 14], &pnl);
        assert!(o.caught);
        assert_eq!(o.scores[0], -CAUGHT_FINE);
        assert_eq!(o.scores[1], 10 + ACCUSE_WIN + 450);
        assert_eq!(o.scores[2], 20 + ALLIN_WIN + 450);
        assert_eq!(o.scores[3], 30 - ALLIN_LOSS);
        assert_eq!(o.scores[4], 40);
        assert_eq!(o.scores[5], 50);

        // Uncaught with invalid vote values 7 and 254 ignored.
        let o2 = score_round(0, &[NONE, 7, 254, CONVICTION + 1, NONE, NONE], &[100; SEATS]);
        assert!(!o2.caught);
        assert_eq!(o2.scores[1], 100);
        assert_eq!(o2.scores[2], 100);
        assert_eq!(o2.scores[3], 100 - ALLIN_LOSS);
    }

    #[test]
    fn blown_tip_applies_only_to_uncaught_non_positive_insider() {
        // Uncaught with 0 profit -> -BLOWN_TIP
        let o_zero = score_round(1, &[NONE; SEATS], &[0; SEATS]);
        assert!(!o_zero.caught);
        assert_eq!(o_zero.scores[1], -BLOWN_TIP);

        // Uncaught with negative profit -> pnl - BLOWN_TIP
        let o_neg = score_round(1, &[NONE; SEATS], &[0, -25_000_000, 0, 0, 0, 0]);
        assert!(!o_neg.caught);
        assert_eq!(o_neg.scores[1], -25_000_000 - BLOWN_TIP);

        // Uncaught with positive profit -> doubles, no BLOWN_TIP
        let o_pos = score_round(1, &[NONE; SEATS], &[0, 40_000_000, 0, 0, 0, 0]);
        assert!(!o_pos.caught);
        assert_eq!(o_pos.scores[1], 80_000_000);

        // Caught with zero or negative profit -> CAUGHT_FINE only, no BLOWN_TIP
        let o_caught = score_round(1, &[1, NONE, 1, NONE, NONE, NONE], &[0, -25_000_000, 0, 0, 0, 0]);
        assert!(o_caught.caught);
        assert_eq!(o_caught.scores[1], -25_000_000 - CAUGHT_FINE);
    }

    fn blank_board() -> Board {
        Board { bump: 255, posted: [0; BOARD_TABLES], entries: [Entry::default(); BOARD_LEN] }
    }

    fn settled_table(id: u64, round: u64, insider: u8, caught: bool) -> Table {
        Table {
            authority: Pubkey::new_unique(),
            id,
            bump: 255,
            phase: Phase::Settled as u8,
            round,
            nonce: 1,
            requested_at: 0,
            t_start: 1_000,
            settled_at: 1_075,
            open_price: P,
            oracle_price: P,
            price: P,
            shock_bps: 0,
            shocks_seen: 4,
            entropy: [0; 32],
            seats: [Seat::default(); SEATS],
            tape: [Print::default(); TAPE],
            tape_len: 0,
            insider,
            caught,
            votes: [NONE; SEATS],
            shocks: [Shock::default(); SHOCKS],
            revealed_salt: [0; 32],
        }
    }

    #[test]
    fn board_post_round_insert_update_streaks_escapes_and_mask() {
        let mut board = blank_board();
        let p0 = Pubkey::new_unique();
        let p1 = Pubkey::new_unique();
        let bot = Pubkey::new_unique();

        // Round 1 on table 7100: p0 (seat 0) catches insider (seat 1) via all-in; p1 (seat 1) escapes = false; bot (seat 2) masked out.
        let mut t1 = settled_table(7100, 1, 1, false);
        t1.seats[0] = Seat { player: p0, last: 250, ..Seat::default() };
        t1.seats[1] = Seat { player: p1, last: 400, ..Seat::default() };
        t1.seats[2] = Seat { player: bot, last: 999, ..Seat::default() };
        t1.votes = [CONVICTION + 1, NONE, 1, NONE, NONE, NONE];

        post_board_round(&mut board, &t1, 0b0000_0011).unwrap();
        assert_eq!(board.posted[7100 % BOARD_TABLES], 1);
        assert_eq!(board.entries[0].player, p0);
        assert_eq!((board.entries[0].score, board.entries[0].rounds, board.entries[0].caught, board.entries[0].streak, board.entries[0].best), (250, 1, 1, 1, 1));
        assert_eq!(board.entries[1].player, p1);
        assert_eq!((board.entries[1].score, board.entries[1].rounds, board.entries[1].escapes, board.entries[1].streak), (400, 1, 1, 0));
        assert!(board.entries[2..].iter().all(|e| e.player == Pubkey::default()));

        // Re-posting the same round on the same table is rejected.
        assert_tipoff_err(post_board_round(&mut board, &t1, 0b11), TipoffError::AlreadyPosted);

        // Non-settled table is rejected.
        let mut live = settled_table(7101, 1, 0, false);
        live.phase = Phase::Live as u8;
        assert_tipoff_err(post_board_round(&mut board, &live, 0b11), TipoffError::WrongPhase);

        // Round 2: p0 catches again (streak 2, best 2); p1 votes wrong -> streak 0.
        let mut t2 = settled_table(7100, 2, 3, true);
        t2.seats[0] = Seat { player: p0, last: 100, ..Seat::default() };
        t2.seats[1] = Seat { player: p1, last: -50, ..Seat::default() };
        t2.votes = [3, 0, NONE, NONE, NONE, NONE];
        post_board_round(&mut board, &t2, 0b11).unwrap();
        assert_eq!((board.entries[0].score, board.entries[0].rounds, board.entries[0].caught, board.entries[0].streak, board.entries[0].best), (350, 2, 2, 2, 2));

        // Round 3: p0 abstains -> streak stays 2; Round 4: p0 votes wrong -> streak resets to 0, best stays 2.
        let mut t3 = settled_table(7100, 3, 2, false);
        t3.seats[0] = Seat { player: p0, last: 20, ..Seat::default() };
        t3.votes[0] = NONE;
        post_board_round(&mut board, &t3, 0b01).unwrap();
        assert_eq!((board.entries[0].streak, board.entries[0].best), (2, 2));

        let mut t4 = settled_table(7100, 4, 2, false);
        t4.seats[0] = Seat { player: p0, last: -30, ..Seat::default() };
        t4.votes[0] = 4;
        post_board_round(&mut board, &t4, 0b01).unwrap();
        assert_eq!((board.entries[0].score, board.entries[0].rounds, board.entries[0].streak, board.entries[0].best), (340, 4, 0, 2));
    }

    #[test]
    fn board_post_round_evicts_lowest_only_for_strictly_higher_score() {
        let mut board = blank_board();
        for i in 0..BOARD_LEN {
            board.entries[i] = Entry {
                player: Pubkey::new_unique(),
                score: (i as i64 + 1) * 100,
                rounds: 1,
                ..Entry::default()
            };
        }
        let lowest_player = board.entries[0].player;

        // Equal score (100 == 100) does NOT evict.
        let mut t_eq = settled_table(7100, 1, 5, false);
        let p_eq = Pubkey::new_unique();
        t_eq.seats[0] = Seat { player: p_eq, last: 100, ..Seat::default() };
        post_board_round(&mut board, &t_eq, 0b01).unwrap();
        assert_eq!(board.entries[0].player, lowest_player);

        // Strictly higher score (101 > 100) evicts lowest_player.
        let mut t_hi = settled_table(7100, 2, 5, false);
        let p_hi = Pubkey::new_unique();
        t_hi.seats[0] = Seat { player: p_hi, last: 101, ..Seat::default() };
        post_board_round(&mut board, &t_hi, 0b01).unwrap();
        assert_eq!(board.entries[0].player, p_hi);
        assert_eq!(board.entries[0].score, 101);
    }
}
