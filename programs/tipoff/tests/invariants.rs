use anchor_lang::prelude::Pubkey;
use proptest::prelude::*;
use solana_sha256_hasher::hashv;
use tipoff::rules::{
    apply_trade, decode_vote, draw_round, equity, levered, score_round, shocked, ACCUSE_LOSS,
    ACCUSE_WIN, ALLIN_LOSS, ALLIN_WIN, BLOWN_TIP, CAUGHT_FINE, MAX_POS, MAX_SWING_BPS, ROUND_SECS,
};
use tipoff::state::{
    Print, Seat, SeatPrivate, Table, NONE, ROLE_INSIDER, SEATS, SHOCKS, TAPE,
};

fn window_shock_bounds(window: usize) -> core::ops::RangeInclusive<i16> {
    match window {
        2 => 120..=375,
        3 => 160..=500,
        _ => 80..=250,
    }
}

#[test]
fn draw_uniformity_across_many_seeds() {
    const N: u32 = 12_000;
    let mut seat_counts = [0u32; SEATS];
    let mut up = 0u32;
    let mut down = 0u32;
    let mut offset_counts = [0u32; 12];
    let mut mag_buckets = [0u32; 3]; // equal-width raw thirds per window (scaled on windows 2, 3)

    for n in 0..N {
        let salt = hashv(&[b"uniformity", &n.to_le_bytes()]).to_bytes();
        let d = draw_round(&salt);
        assert!((d.insider as usize) < SEATS);
        seat_counts[d.insider as usize] += 1;

        for (i, sh) in d.shocks.iter().enumerate() {
            let win_start = 8 + (i as u8) * 12;
            assert!(sh.at >= win_start && sh.at < win_start + 12);
            offset_counts[(sh.at - win_start) as usize] += 1;

            if sh.bps > 0 {
                up += 1;
            } else {
                down += 1;
            }
            let mag = sh.bps.abs();
            assert!(window_shock_bounds(i).contains(&mag), "window {i} mag {mag}");
            let (b1, b2) = match i {
                2 => (204, 289),
                3 => (272, 386),
                _ => (136, 193),
            };
            if mag <= b1 {
                mag_buckets[0] += 1;
            } else if mag <= b2 {
                mag_buckets[1] += 1;
            } else {
                mag_buckets[2] += 1;
            }
        }
    }

    // Expected: 2,000 per seat across 12,000 seeds; allow +/- 15%.
    for (idx, &count) in seat_counts.iter().enumerate() {
        assert!(
            (1700..=2300).contains(&count),
            "seat {idx} count {count} outside uniform tolerance"
        );
    }

    // Expected: 24,000 up and 24,000 down across 48,000 shocks.
    assert!((23_000..=25_000).contains(&up), "up count {up}");
    assert!((23_000..=25_000).contains(&down), "down count {down}");

    // Expected: 4,000 per window offset across 48,000 shocks.
    for (off, &count) in offset_counts.iter().enumerate() {
        assert!(
            (3_600..=4_400).contains(&count),
            "offset {off} count {count} outside uniform tolerance"
        );
    }

    // Expected: ~16,000 per magnitude bucket across 48,000 shocks.
    for (b, &count) in mag_buckets.iter().enumerate() {
        assert!(
            (14_800..=17_200).contains(&count),
            "magnitude bucket {b} count {count} outside uniform tolerance"
        );
    }
}

#[test]
fn state_helpers_work_as_documented() {
    let wallet = Pubkey::new_unique();
    let session = Pubkey::new_unique();
    let stranger = Pubkey::new_unique();

    let empty = Seat::default();
    assert!(!empty.signed_by(&Pubkey::default()));
    assert!(!empty.signed_by(&stranger));

    let seated = Seat {
        player: wallet,
        session,
        ..Default::default()
    };
    assert!(seated.signed_by(&wallet));
    assert!(seated.signed_by(&session));
    assert!(!seated.signed_by(&stranger));

    let mut priv_seat = SeatPrivate {
        table: Pubkey::new_unique(),
        idx: 2,
        bump: 254,
        round: 9,
        role: ROLE_INSIDER,
        shocks: [tipoff::state::Shock { at: 10, bps: 100 }; SHOCKS],
        vote: 4,
    };
    priv_seat.reset();
    assert_eq!(priv_seat.round, 0);
    assert_eq!(priv_seat.role, 0);
    assert_eq!(priv_seat.vote, NONE);
    assert!(priv_seat.shocks.iter().all(|s| s.at == 0 && s.bps == 0));

    let mut table = Table {
        authority: wallet,
        id: 7103,
        bump: 255,
        phase: 0,
        round: 0,
        nonce: 0,
        requested_at: 0,
        t_start: 0,
        settled_at: 0,
        open_price: 0,
        oracle_price: 0,
        price: 0,
        shock_bps: 0,
        shocks_seen: 0,
        entropy: [0; 32],
        seats: [Seat::default(); SEATS],
        tape: [Print::default(); TAPE],
        tape_len: 0,
        insider: NONE,
        caught: false,
        votes: [NONE; SEATS],
        shocks: [tipoff::state::Shock::default(); SHOCKS],
        revealed_salt: [0; 32],
    };
    for i in 0..(TAPE + 5) {
        table.push_tape(Print {
            seat: (i % SEATS) as u8,
            delta: 1,
            price: 100 + i as i64,
            t: i as u16,
        });
    }
    assert_eq!(table.tape_len as usize, TAPE + 5);
    // Slot 0 should have been overwritten by index 24 (price 124).
    assert_eq!(table.tape[0].price, 124);
    assert_eq!(table.tape[4].price, 128);
    assert_eq!(table.tape[5].price, 105);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn prop_draw_round_deterministic_and_within_documented_bounds(salt in any::<[u8; 32]>()) {
        let d1 = draw_round(&salt);
        let d2 = draw_round(&salt);

        prop_assert_eq!(d1.insider, d2.insider);
        prop_assert_eq!(d1.shocks, d2.shocks);
        prop_assert!((d1.insider as usize) < SEATS);

        for (i, sh) in d1.shocks.iter().enumerate() {
            let min_at = 8 + (i as u8) * 12;
            let max_at = min_at + 12;
            prop_assert!(sh.at >= min_at && sh.at < max_at);
            prop_assert!((sh.at as i64) < ROUND_SECS);
            if i > 0 {
                prop_assert!(sh.at > d1.shocks[i - 1].at);
            }
            let mag = sh.bps.abs();
            prop_assert!(window_shock_bounds(i).contains(&mag));
        }
    }

    #[test]
    fn prop_apply_trade_keeps_position_within_limits_and_preserves_state_on_error(
        deltas in prop::collection::vec(-20i8..=20i8, 1..40),
        open in 1_000_000i64..=1_000_000_000_000i64,
        prices in prop::collection::vec(1_000_000i64..=1_000_000_000_000i64, 1..40),
    ) {
        let mut seat = Seat::default();
        for (idx, &delta) in deltas.iter().enumerate() {
            let price = prices[idx % prices.len()];
            let prev = (seat.pos, seat.cash, seat.trades);
            let res = apply_trade(&mut seat, delta, price, open);

            let expected_ok = delta != 0 && prev.0.checked_add(delta).is_some_and(|p| p.abs() <= MAX_POS);
            prop_assert_eq!(res.is_ok(), expected_ok);
            prop_assert!(seat.pos.abs() <= MAX_POS);

            if expected_ok {
                prop_assert_eq!(seat.pos, prev.0 + delta);
                prop_assert_eq!(seat.trades, prev.2 + 1);
            } else {
                prop_assert_eq!((seat.pos, seat.cash, seat.trades), prev);
            }
        }

        // Flattening any non-zero position at `close_price` leaves cash equal to mark-to-market equity.
        let close_price = prices[0];
        let mark_eq = equity(&seat, close_price, open).unwrap();
        if seat.pos != 0 {
            let flatten_delta = -seat.pos;
            apply_trade(&mut seat, flatten_delta, close_price, open).unwrap();
            prop_assert_eq!(seat.pos, 0);
            prop_assert_eq!(seat.cash, mark_eq);
            prop_assert_eq!(equity(&seat, close_price, open).unwrap(), seat.cash);
        } else {
            prop_assert_eq!(seat.cash, mark_eq);
        }
    }

    #[test]
    fn prop_round_trip_at_constant_price_leaves_zero_cash(
        deltas in prop::collection::vec(-5i8..=5i8, 1..25),
        open in 1_000_000i64..=1_000_000_000_000i64,
    ) {
        let mut seat = Seat::default();
        for &d in &deltas {
            let _ = apply_trade(&mut seat, d, open, open);
        }
        if seat.pos != 0 {
            let flatten_delta = -seat.pos;
            apply_trade(&mut seat, flatten_delta, open, open).unwrap();
        }
        prop_assert_eq!(seat.pos, 0);
        prop_assert_eq!(seat.cash, 0);
        prop_assert_eq!(equity(&seat, open, open).unwrap(), 0);
    }

    #[test]
    fn prop_shocked_is_deterministic_and_monotonic_for_valid_bps(
        oracle_price in 10_000i64..=1_000_000_000_000i64,
        bps in -1_000i32..=1_000i32,
    ) {
        let p1 = shocked(oracle_price, bps).unwrap();
        let p2 = shocked(oracle_price, bps).unwrap();
        prop_assert_eq!(p1, p2);
        if bps > 0 {
            prop_assert!(p1 >= oracle_price);
        } else if bps < 0 {
            prop_assert!(p1 <= oracle_price);
        } else {
            prop_assert_eq!(p1, oracle_price);
        }
        prop_assert!(p1 > 0);
    }

    #[test]
    fn prop_score_round_invariants_and_chip_conservation(
        insider in 0u8..(SEATS as u8),
        votes in prop::array::uniform6(prop_oneof![0u8..=15u8, Just(254u8), Just(255u8)]),
        pnl in prop::array::uniform6(-1_000_000_000_000i64..=1_000_000_000_000i64),
    ) {
        let out1 = score_round(insider, &votes, &pnl);
        let out2 = score_round(insider, &votes, &pnl);
        prop_assert_eq!(out1.caught, out2.caught);
        prop_assert_eq!(out1.scores, out2.scores);

        let k = insider as usize;
        let mut tally = [0u8; SEATS];
        let mut vote_net = 0i128;
        for (i, &v) in votes.iter().enumerate() {
            if i != k {
                if let Some((target, all_in)) = decode_vote(v) {
                    tally[target as usize] += 1;
                    if target == insider {
                        vote_net += if all_in { ALLIN_WIN } else { ACCUSE_WIN } as i128;
                    } else {
                        vote_net -= if all_in { ALLIN_LOSS } else { ACCUSE_LOSS } as i128;
                    }
                }
            }
        }
        let correct_votes = tally[k] as i64;
        let expected_caught = tally[k] >= 2
            && tally.iter().enumerate().all(|(i, &n)| i == k || n < tally[k]);
        prop_assert_eq!(out1.caught, expected_caught);

        let insider_profit = pnl[k].max(0);
        for i in 0..SEATS {
            if i == k {
                if expected_caught {
                    prop_assert_eq!(out1.scores[k], pnl[k].min(0) - CAUGHT_FINE);
                } else if pnl[k] > 0 {
                    prop_assert_eq!(out1.scores[k], pnl[k] + insider_profit);
                } else {
                    prop_assert_eq!(out1.scores[k], pnl[k] - BLOWN_TIP);
                }
            } else if let Some((target, all_in)) = decode_vote(votes[i]) {
                if target == insider {
                    let stake = if all_in { ALLIN_WIN } else { ACCUSE_WIN };
                    let bonus = if expected_caught { insider_profit / correct_votes } else { 0 };
                    prop_assert_eq!(out1.scores[i], pnl[i] + stake + bonus);
                } else {
                    let loss = if all_in { ALLIN_LOSS } else { ACCUSE_LOSS };
                    prop_assert_eq!(out1.scores[i], pnl[i] - loss);
                }
            } else {
                prop_assert_eq!(out1.scores[i], pnl[i]);
            }
        }

        // Chip conservation: exact sum matches documented stakes and payouts minus integer split remainder.
        let sum_pnl: i128 = pnl.iter().map(|&x| x as i128).sum();
        let sum_scores: i128 = out1.scores.iter().map(|&x| x as i128).sum();
        if expected_caught {
            let distributed = (correct_votes as i128) * ((insider_profit / correct_votes) as i128);
            let remainder = (insider_profit as i128) - distributed;
            prop_assert!(remainder >= 0 && remainder < correct_votes as i128);
            let expected_sum = sum_pnl + vote_net - (CAUGHT_FINE as i128) - remainder;
            prop_assert_eq!(sum_scores, expected_sum);
        } else {
            let insider_delta = if pnl[k] > 0 { insider_profit as i128 } else { -(BLOWN_TIP as i128) };
            let expected_sum = sum_pnl + vote_net + insider_delta;
            prop_assert_eq!(sum_scores, expected_sum);
        }
    }

    #[test]
    fn prop_full_round_pipeline_end_to_end(
        salt in any::<[u8; 32]>(),
        open_price in 50_00000000i64..=300_00000000i64,
        trade_deltas in prop::array::uniform6(prop::collection::vec(-5i8..=5i8, 0..8)),
        votes in prop::array::uniform6(0u8..=7u8),
    ) {
        let draw = draw_round(&salt);
        let mut seats = [Seat::default(); SEATS];
        let mut current_price = open_price;
        let mut cum_bps = 0i32;

        // Apply shocks sequentially alongside each seat's trades.
        for step in 0..SHOCKS {
            cum_bps += draw.shocks[step].bps as i32;
            current_price = shocked(open_price, cum_bps).unwrap();
            for s_idx in 0..SEATS {
                if let Some(&delta) = trade_deltas[s_idx].get(step) {
                    let _ = apply_trade(&mut seats[s_idx], delta, current_price, open_price);
                }
                prop_assert!(seats[s_idx].pos.abs() <= MAX_POS);
            }
        }

        let mut pnl = [0i64; SEATS];
        for s_idx in 0..SEATS {
            pnl[s_idx] = equity(&seats[s_idx], current_price, open_price).unwrap();
        }
        let outcome = score_round(draw.insider, &votes, &pnl);
        prop_assert_eq!(outcome.scores.len(), SEATS);
    }

    #[test]
    fn prop_levered_bounds_and_shock_composition(
        open_price in 50_00000000i64..=300_00000000i64,
        oracle_delta_bps in -2_000i64..=2_000i64,
        shock_bps in -1_375i32..=1_375i32,
    ) {
        let oracle_price = (open_price as i128 * (10_000 + oracle_delta_bps as i128) / 10_000) as i64;
        let lev = levered(oracle_price, open_price).unwrap();
        let min_lev = shocked(open_price, -(MAX_SWING_BPS as i32)).unwrap();
        let max_lev = shocked(open_price, MAX_SWING_BPS as i32).unwrap();
        prop_assert!(lev >= min_lev && lev <= max_lev);
        let composed = shocked(lev, shock_bps).unwrap();
        prop_assert!(composed > 0);
    }
}
