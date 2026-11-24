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

To inspect the reproducing failures for the two `#[ignore]` suspected-bug tests:

```bash
cargo test -p tipoff -- --ignored
```

## Test Groups

| Group | Location | Total | Passed | Ignored | Coverage |
| :--- | :--- | :---: | :---: | :---: | :--- |
| Game rules & draw unit tests (`rules::tests`) | `programs/tipoff/src/rules.rs` | 19 | 18 | 1 | Private `lots_value`, `apply_trade` (+/-5 limits, zero delta, `i8`/cash/`lots_value` overflow, zero price), `shocked` (zero, +/-bps, truncation, overflow), `equity`, `score_round` (caught vs escaped, ties, nobody votes, everyone votes insider, negative insider profit, 2/3/4/5-way split rounding, conservation, all 6 seats), `draw_round` determinism and bounds |
| Oracle unit tests (`oracle::tests`) | `programs/tipoff/src/oracle.rs` | 10 | 9 | 1 | `read_price` account key, program owner, `feed_id` mismatch/bit-flip, data length boundaries (`0`, `8`, `9`, `132`, `133`, trailing bytes), `VerificationLevel::Full` and `Partial`, invalid enum tag, price (`0`, `-1`, `i64::MIN`, `1`, `i64::MAX`), slot (`0`, `1`, `u64::MAX`), +/-30s freshness boundaries |
| Program helper unit tests (`lib::tests` + `test_id`) | `programs/tipoff/src/lib.rs` | 3 | 3 | 0 | Anchor program ID check, private `refresh` (phase guard, `BadSecret`, oracle fallback on stale/post-60s feed, progressive shock reveal), private `deal_seat` and `load_seat` (`ROLE_INSIDER` vs `ROLE_TRADER` shock visibility, `BadSeat` checks) |
| Property & distribution tests (`invariants`) | `programs/tipoff/tests/invariants.rs` | 8 | 8 | 0 | 12,000-seed VRF draw uniformity (seats, shock directions, window offsets, magnitude buckets), `Seat`/`SeatPrivate`/`Table` helpers, and 6 `proptest` suites (256 cases each) for position bounds, revert-on-error, round-trip cash neutrality, shock monotonicity, settlement chip conservation, and end-to-end round pipeline |
| **Total** | | **40** | **38** | **2** | **38 passed, 0 failed, 2 ignored** |

## Latest Test Summary

Unit tests (`unittests src/lib.rs`):

```
test result: ok. 30 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.02s
```

Integration / property tests (`tests/invariants.rs`):

```
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.11s
```

## Suspected Bugs

1. **`apply_trade` panics on `i8::MIN` (`pos + delta == -128`) instead of returning `TipoffError::PositionLimit`**
   - **Location:** `programs/tipoff/src/rules.rs:51` (`rules::tests::suspected_bug_apply_trade_i8_min_panics_instead_of_position_limit`, marked `#[ignore]`)
   - **Input:** `seat = Seat { pos: 0, ..Default::default() }`, `delta = i8::MIN` (`-128`), `price = 150_00000000`, `open = 150_00000000` (via `trade` instruction accepting any `delta: i8`)
   - **Expected:** `Err(TipoffError::PositionLimit)` (consistent with `delta = i8::MAX`, `delta = -6`, and the `checked_add` error handling on line 50)
   - **Actual:** Panics with `attempt to negate with overflow` inside `pos.abs()` because `(-128i8).abs()` overflows `i8`. Because `Cargo.toml` enables `overflow-checks = true` in `[profile.release]`, calling `trade` with `delta = -128` from `pos = 0` aborts on-chain instead of returning `PositionLimit`.

2. **`oracle::read_price` panics on extreme `publish_time` values instead of returning `TipoffError::BadPrice`**
   - **Location:** `programs/tipoff/src/oracle.rs:43` (`oracle::tests::suspected_bug_read_price_extreme_timestamp_panics_instead_of_bad_price`, marked `#[ignore]`)
   - **Input:** `feed = SOL_USD_FEED`, `owner = ORACLE_PROGRAM`, `feed_id = SOL_USD_FEED.to_bytes()`, `price = 100`, `publish_time = i64::MIN`, `posted_slot = 1`, `now = 1_800_000_000`
   - **Expected:** `Err(TipoffError::BadPrice)` (rejecting stale/invalid oracle timestamps cleanly)
   - **Actual:** Panics with `attempt to subtract with overflow` in `(now - u.publish_time).abs()` (`oracle.rs:43`) instead of using non-overflowing difference arithmetic (`now.abs_diff(u.publish_time)`).
