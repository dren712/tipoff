# Tipoff Rust Test Suite

## How to Run

Run all unit and property-based integration tests for the Solana program:

```bash
cargo test -p tipoff
```

Verify that the Solana SBF program and Anchor IDL still build cleanly:

```bash
anchor build --ignore-keys
```

## Test Groups

| Group | Location | Total | Passed | Ignored | Coverage |
| :--- | :--- | :---: | :---: | :---: | :--- |
| Game rules & draw unit tests (`rules::tests`) | `programs/tipoff/src/rules.rs` | 26 | 26 | 0 | Private `lots_value`, `apply_trade` (+/-5 limits, zero delta, `i8`/cash/`lots_value` overflow, zero price), `levered` (`0` move, `+0.10%` -> `+1.20%`, +/-`600` bps clamp, `BadPrice`, overflow), `shocked` (zero, +/-bps, truncation, overflow), `equity`, `score_round` (caught vs escaped, all-in `8..=13` stakes, invalid votes `6/7/14/254`, blown-tip `-50` penalty, ties, nobody votes, everyone votes insider, 2/3/4/5-way split rounding, conservation, all 6 seats), `draw_round` determinism, fixed-salt vector, escalating window bounds, 2/3 rumour rate, and `post_board_round` (insert, update, streak, escapes, mask, duplicate round, lowest-score eviction) |
| Oracle unit tests (`oracle::tests`) | `programs/tipoff/src/oracle.rs` | 10 | 10 | 0 | `read_price` account key, program owner, `feed_id` mismatch/bit-flip, data length boundaries (`0`, `8`, `9`, `132`, `133`, trailing bytes), `VerificationLevel::Full` and `Partial`, invalid enum tag, price (`0`, `-1`, `i64::MIN`, `1`, `i64::MAX`), slot (`0`, `1`, `u64::MAX`), +/-30s freshness boundaries |
| Program helper unit tests (`lib::tests` + `test_id`) | `programs/tipoff/src/lib.rs` | 6 | 6 | 0 | Anchor program ID check, private `refresh` (phase guard, `BadSecret`, oracle fallback on stale/post-60s feed, progressive shock reveal, 12x levered price, rumour slot at `at - 5` replaced at `at`), `apply_close` settle-price composition, `validate_vote` (all-in & self-vote/invalid-byte rejection), private `deal_seat` and `load_seat` (`ROLE_INSIDER` vs `ROLE_TRADER` shock visibility, `BadSeat` checks) |
| Property & distribution tests (`invariants`) | `programs/tipoff/tests/invariants.rs` | 9 | 9 | 0 | 12,000-seed VRF draw uniformity (seats, shock directions, window offsets, scaled magnitude buckets), `Seat`/`SeatPrivate`/`Table` helpers, and 7 `proptest` suites (256 cases each) for position bounds, revert-on-error, round-trip cash neutrality, shock monotonicity, levered bounds + shock composition, settlement chip conservation (normal + all-in + blown-tip), and end-to-end round pipeline |
| **Total** | | **51** | **51** | **0** | **51 passed, 0 failed, 0 ignored** |

## Latest Test Summary

Unit tests (`unittests src/lib.rs`):

```
test result: ok. 42 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s
```

Integration / property tests (`tests/invariants.rs`):

```
test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.11s
```

## Bugs found by this suite (fixed)

Both aborted the transaction, so neither could change game state, but they failed with a panic instead of the documented error.

1. `apply_trade` panicked when `pos + delta == i8::MIN` (`pos.abs()` overflow). Now a range check returning `PositionLimit`; covered by `rules::tests::apply_trade_i8_min_is_position_limit`.
2. `oracle::read_price` panicked on an extreme `publish_time` (`now - publish_time` overflow). Now `abs_diff`, returning `BadPrice`; covered by `oracle::tests::read_price_extreme_timestamp_is_bad_price`.
