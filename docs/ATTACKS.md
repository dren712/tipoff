# Tipoff Security Attack Verification

Date: 2026-11-24

## Live Test Output

```
> attack
> tsx scripts/attack.ts

Attacker keypair: 6yrvh4DFGiG88by5cpkbAk5i84emJVzD6yLNkKmv8NiV
Target table: 7103 (5zLS4MjmcJ8PmyqTo5fzg9iMPoA4AQb4KwhYCNnu69sT)
  attacker sit seat 2: 284 ms  3tWUaMPBLjdJ6EDb…
Attacker seated at seat 2
Waiting for live round...
Round 9 is live! Running live attacks...
PASS read_sealed: rejected with no data returned (protected by TEE permissions)
PASS trade_unowned_seat: rejected with Unauthorized (Signer is not this seat's wallet or session key)
PASS trade_position_limit: rejected with PositionLimit (Position limit exceeded)
PASS vote_self: rejected with BadSeat (Bad seat)
PASS vote_twice: rejected with Custom error 6011
PASS settle_early: rejected with TooEarly (Too early)
PASS fake_vrf_callback: rejected with ConstraintAddress (An address constraint was violated)
PASS start_round_live: rejected with WrongPhase (Not allowed in this phase)
PASS tick_fake_price_feed: rejected with ConstraintAddress (An address constraint was violated)
PASS checkpoint_unsettled_stranger: rejected with ConstraintHasOne (A has_one constraint was violated)
Waiting for round to settle for attack 7...
Round settled (phase 3). Running attack 7...
PASS settle_twice: rejected with WrongPhase (Not allowed in this phase)
Freeing seat 2 with stand...
  stand: 232 ms  5sHYTLHe7xftp7Gm…
Seat 2 freed successfully.
11/11 attacks rejected
```

## Vulnerability & Defense Analysis

1. **`read_sealed`**: Stopped by `seal_secret` (`lib.rs:158-163`) and `sit` (`lib.rs:198-202`) configuring MagicBlock TEE Ephemeral Permissions, which enforces empty member access for the table's `Secret` and restricts `SeatPrivate` solely to the seated player's registered wallet/session keys.
2. **`trade_unowned_seat`**: Stopped by `require!(seat.signed_by(&ctx.accounts.signer.key()), TipoffError::Unauthorized);` in `trade` (`lib.rs:346`).
3. **`trade_position_limit`**: Stopped by `require!(delta != 0 && pos.abs() <= MAX_POS, TipoffError::PositionLimit);` inside `apply_trade` invoked by `trade` (`rules.rs:51`, called from `lib.rs:347`).
4. **`vote_self`**: Stopped by `require!((suspect as usize) < SEATS && suspect != p.idx, TipoffError::BadSeat);` in `vote` (`lib.rs:360`).
5. **`vote_twice`**: Stopped by `require!(p.round != t.round || p.vote == NONE, TipoffError::AlreadyVoted);` in `vote` (error 6011). The first run of this script found that a second vote replaced the first; the program was changed so an accusation is final, redeployed, and the script rerun (the `vote_twice` line above is from that rerun).
6. **`settle_early`**: Stopped by `require!(now >= t.t_start + ROUND_SECS + VOTE_SECS, TipoffError::TooEarly);` in `settle` (`lib.rs:371`).
7. **`settle_twice`**: Stopped by `require!(t.phase == Phase::Live as u8, TipoffError::WrongPhase);` in `settle` (`lib.rs:370`).
8. **`fake_vrf_callback`**: Stopped by Anchor's address constraint `#[account(address = VRF_CALLBACK_IDENTITY)]` on `vrf_program_identity` in `OnRandom` (`lib.rs:764`).
9. **`start_round_live`**: Stopped by `require!(t.phase == Phase::Idle as u8 || t.phase == Phase::Settled as u8 || retry, TipoffError::WrongPhase);` in `start_round` (`lib.rs:237-240`).
10. **`tick_fake_price_feed`**: Stopped by Anchor's address constraint `#[account(address = oracle::SOL_USD_FEED)]` on `price_feed` in `Tick` (`lib.rs:782`).
11. **`checkpoint_unsettled_stranger`**: The stranger signs as both `payer` and `authority`, but Anchor rejects the call at the `#[account(mut, has_one = authority)]` check on `table` in `Checkpoint`; only the actual table authority may authorize spending the delegated house payer's commit budget. The phase constraint also rejects unsettled tables.
