# Tipoff

A 60-second trading game where one of six players secretly knows the news. If the shock list were readable, everyone would be the insider, so the game only works inside a MagicBlock private rollup.

- **Play (no wallet):** https://dren712.github.io/tipoff/
- **Video:** VIDEO_URL_HERE
- **Proof:** [docs/ATTACKS.md](docs/ATTACKS.md) | [Solana Explorer](https://explorer.solana.com/address/BuxvayFhHgiWwvUtCofARcq9HcHzyvk5FPoGANsEw87M?cluster=devnet)

![Live 3D trading floor on desktop](docs/screens/desktop-live.png)

<p>
  <img src="docs/screens/desktop-vote.png" alt="Sealed accusation line-up on desktop" width="40%" />
  <img src="docs/screens/desktop-reveal.png" alt="Caged insider reveal and round scores on desktop" width="40%" />
  <img src="docs/screens/phone-live.png" alt="Live trading screen on mobile" width="12%" />
</p>

Six traders share one live SOL/USD price (`12x` oracle move clamped at `+/-600` bps) while four news shocks hit it during a 60-second round. MagicBlock VRF secretly picks one seat as the insider and delivers the shock schedule only to that player's private account. Every position move prints publicly on a 3D floor and trade tape, and when trading closes everyone casts a single sealed accusation.

Built for Solana Blitz v10 on MagicBlock's Private Ephemeral Rollup.

| | |
|---|---|
| Program (devnet) | [`BuxvayFhHgiWwvUtCofARcq9HcHzyvk5FPoGANsEw87M`](https://explorer.solana.com/address/BuxvayFhHgiWwvUtCofARcq9HcHzyvk5FPoGANsEw87M?cluster=devnet) |
| Rollup | MagicBlock devnet TEE validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` |
| Oracle | Pyth Lazer SOL/USD feed `ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu` |
| Stakes | Play chips only. No tokens change hands. |

## How a round plays

1. **Sit down and deal roles.** Six seats (`Ruby`, `Amber`, `Rusty`, `Jade`, `Azure`, `Violet`) join with a browser guest key and zero gas fees. MagicBlock VRF inside the private rollup chooses one insider and four escalating shocks (`0.8%` to `2.5%` in windows 1–2, `1.2%` to `3.75%` in window 3, `1.6%` to `5.0%` in window 4, up or down in 12-second windows between `8 s` and `56 s`), writing the shock list only to the insider's private seat account.
2. **Trade on the six-lane deck (60 seconds).** Each robot stands on its own lane between the green `LONG` gate and the red `SHORT` gate, holding up to `+5` lots long or `-5` lots short (`1,000` chips per lot at the opening price). Buying or selling moves the robot along its lane and updates the public trade tape and back-wall price chart.
3. **React to rumours and news shocks.** Five seconds before each shock, the table publishes a public rumour (`+1` or `-1` bps, matching the true direction two times in three). As each scheduled shock lands, the SOL/USD floor price jumps or drops, marking the back-wall chart and public tape so non-insiders can look for whoever positioned just beforehand.
4. **Cast a sealed accusation (15 seconds).** When the 60-second clock ends, all six robots walk into a front-row line-up (`Who was the insider?`). Each player can accuse one suspect normally (`0..=5`) or go all-in (`8..=13`), writing their vote to their private seat account; an accusation is final once cast and stays hidden from everyone until settlement.
5. **Unmask and settle.** After `75` seconds (`60 s` trading + `15 s` voting), `settle` reveals the insider, shocks, votes, and salt: caught insiders drop into a red cage while uncaught insiders celebrate, scores are settled, and `checkpoint` commits the table back to Solana.

### Scoring

All amounts are chips (`1,000` chips per lot at the opening price, +/-`5` lots max):

- Every seat keeps its trading profit or loss.
- One accusation is allowed per round and is final once cast: a normal accusation earns `100` if right and costs `50` if wrong; an all-in accusation (`CONVICTION`, vote `suspect + 8`) earns `200` if right and costs `150` if wrong; not voting costs nothing.
- The insider is **caught** if they receive at least two votes and strictly more votes than any other seat (own votes ignored). A caught insider loses their profit, pays a `100`-chip fine, and their profit is divided equally among the players who accused them.
- If the insider is not caught, positive profit doubles; if their profit is zero or negative, they pay a `50`-chip blown-tip penalty.

## What you win and keep

Rounds award play chips (`1,000` chips per lot, `+/-5` lots max, plus `100` / `-50` normal or `200` / `-150` all-in accusation stakes). Human players' settled results persist beyond a single round on the shared `Board` PDA (top `50` entries tracking `score`, `rounds`, `caught`, `escapes`, `streak`, and `best`), updated inside the rollup by `post_round` and committed to Solana devnet via `commit_board` (`BOARD_ADDRESS_HERE`).

## Why each MagicBlock piece is needed

Tipoff cannot run on plain Solana because both hidden game state and sub-second trading are required in the same loop. Seated players confirm trades and votes inside the TEE using a browser guest keypair in about 0.5 s per move (median 520 ms in a scripted run), with zero fees and no wallet popups.

| Mechanic (`rules.rs`) | MagicBlock piece | Why it cannot run on plain L1 |
|---|---|---|
| Hidden insider and shocks (`draw_round`) | Private Ephemeral Rollup (`Secret` empty member list + `SeatPrivate` access control) | Public L1 account bytes would let anyone read the shock list and act as insider |
| Rumours (`RUMOUR_LEAD = 5 s`, 2/3 match rate) | Rollup `refresh` reading `Secret` while writing only `+1`/`-1` bps claim onto public `Table` | True shock direction stays hidden on the TEE until `at` lands |
| Sealed and all-in votes (`0..=5`, `CONVICTION = 8` for `8..=13`) | Private `SeatPrivate` accounts + permissionless `settle` | Votes stay hidden per seat until trading and voting close; second votes revert (`AlreadyVoted`) |
| The draw (`draw_round`) | MagicBlock VRF inside the rollup (`start_round` / `on_random`) + `revealed_salt` on `settle` | Operator cannot choose the insider, and anyone can verify `draw_round` from `revealed_salt` |
| The price (`LEVERAGE = 12`x, `+/-600` bps clamp) | Live Pyth Lazer SOL/USD feed read inside the rollup (`tick` & `trade`) + zero-fee guest keys | Live market updates and ~0.5 s per move (`520 ms` scripted median) with no wallet popups |
| The board and ledger (`post_board_round` / `Board` / `Ledger`) | Rollup commit (`commit_board`, `checkpoint` + `record_round` Magic Action) | Moves and scores run fast inside the TEE, then commit permanently to Solana |

Also backing every move:

- **Hidden state permissions:** `Secret` holds salt, insider index, and four shocks under an empty member list on validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`, while `SeatPrivate` restricts reads strictly to that seat's wallet and session key.
- **VRF mixing:** `on_random` checks `VRF_CALLBACK_IDENTITY` and the active request nonce before hashing the VRF output with the prior salt and player `sit` entropy.
- **Solana base-layer commit:** `checkpoint` commits `Table` to Solana devnet and dispatches a `record_round` Magic Action into `Ledger` (`Dx1D48i2W3UTZpnJF1SxocVybbBDT73RjTVHycLvgcAu`); `commit_board` commits `Board` after rounds with human entries.

## Proof

- **11/11 live devnet attacks rejected:** [`npm run attack`](docs/ATTACKS.md) (`scripts/attack.ts`) creates a throwaway unfunded keypair, sits on live devnet table `7103`, and verifies that all 11 cheat attempts fail at the rollup permissions or program checks (`read_sealed`, `trade_unowned_seat`, `trade_position_limit`, `vote_self`, `vote_twice` with `AlreadyVoted` / error `6011`, `settle_early`, `settle_twice`, `fake_vrf_callback`, `start_round_live`, `tick_fake_price_feed`, `checkpoint_unsettled_stranger`). See [`docs/ATTACKS.md`](docs/ATTACKS.md) for the full run and defense mapping.
- **51/51 Rust unit, distribution, and property tests passing:** `cargo test -p tipoff` runs 42 unit tests (`rules.rs`, `oracle.rs`, `lib.rs`) and 9 integration/property tests in `programs/tipoff/tests/invariants.rs` (0 ignored), and `anchor build --ignore-keys` builds the program and IDL. Writing the suite caught two edge-case panics that were fixed and covered by regression tests in [`docs/TESTS.md`](docs/TESTS.md):
  1. `rules::apply_trade` panicked on `pos.abs()` when `pos + delta == i8::MIN` (`-128`); fixed with a range check returning `TipoffError::PositionLimit` (`rules::tests::apply_trade_i8_min_is_position_limit`).
  2. `oracle::read_price` panicked when `now - publish_time` overflowed (for example `publish_time == i64::MIN`); fixed using `abs_diff` returning `TipoffError::BadPrice` (`oracle::tests::read_price_extreme_timestamp_is_bad_price`).
- **On-chain devnet record:** Program [`BuxvayFhHgiWwvUtCofARcq9HcHzyvk5FPoGANsEw87M`](https://explorer.solana.com/address/BuxvayFhHgiWwvUtCofARcq9HcHzyvk5FPoGANsEw87M?cluster=devnet) stores committed `Table` state and the `Ledger` PDA updated by `checkpoint` -> `record_round`.
- **Verify a round's draw in the app:** When a round settles, `settle` writes `revealed_salt` onto the public `Table` account. Click **`Verify the draw`** in the post-round results strip—or open the shield (**`Try to cheat`**) drawer and run **`Verify the draw`**—to recompute `rules.rs::draw_round` locally in the browser (`redraw()` in `app/src/chain.ts`, SHA-256 of `"tipoff-draw"` + `revealed_salt`) and verify that the insider and four shocks match the settled table. The same drawer runs live cheat checks and links **`Solana record`** to the latest `Ledger` transaction on Solana Explorer:

| In-app check | What happens |
|---|---|
| Read the secret (`Try to cheat`) | Rollup returns nothing; `Secret` access list is empty |
| Read another seat | Rollup returns nothing; only that seat's keys can read `SeatPrivate` |
| Read it from Solana | Base layer shows delegation program ownership and frozen pre-game bytes |
| Trade as someone else | Rejected with `Unauthorized`; signer is not that seat's wallet or session key |
| Verify the draw | Recomputes insider and shocks from `revealed_salt` in the browser and compares |
| Solana record | Opens Explorer for the latest `Ledger` checkpoint / `record_round` transaction |

`scripts/round.ts` automates the three-key privacy read checks (outsider, operator, neighbor), and `scripts/leak.ts` checks what rollup transaction history each party can inspect.

## Architecture

```
Solana (devnet)                      Private Ephemeral Rollup (TEE)
---------------                      ------------------------------
init table, secret, 6 seats
delegate all of them  ───────────►   seal_secret: access list = nobody
                                     seal_seat:   access list = nobody
                                     sit:         seat's access list = that player
                                     start_round: request VRF
                                     on_random:   salt = hash(salt, randomness, player entropy)
                                                  insider + 4 shocks derived from salt
                                                  insider's seat account gets the shocks
                                     trade / tick: price = oracle price + shocks so far
                                     vote:        written once to voter's private seat (final)
                                     settle:      reveal insider, shocks, votes, salt
ledger: round recorded  ◄─────────   checkpoint:  commit table + Magic Action (record_round)
```

- **Public (`Table`)**: seats, positions, trade tape (`24` slots), current price, open/oracle prices, and after settlement the insider, shocks, votes, and `revealed_salt`.
- **Private, zero readers (`Secret`)**: current round salt, insider index, and four shock timings. Only the program accesses it inside the TEE.
- **Private, one reader per seat (`SeatPrivate`)**: seat's round, role (`trader` or `insider`), shocks (populated for the insider only), and vote.
- **Profiles, ledger, and board (`Player`, `Ledger`, `Board`)**: `Player` stores wallet/session scores across sessions; `Ledger` stays undelegated on Solana and stores the latest committed round number and `Table` SHA-256 digest; `Board` holds the top `50` guest/human career entries (`score`, `rounds`, `caught`, `escapes`, `streak`, `best`), updated inside the rollup (`post_round`) and committed to Solana (`commit_board`) after rounds with human entries.

## Threat model

| Threat | Defence |
|---|---|
| A player reads the insider or shocks | `Secret` has an empty access list in the TEE; verified by `scripts/round.ts`, `scripts/attack.ts`, and the in-app drawer |
| The operator reads the insider | Same; the table authority is not on `Secret` or player `SeatPrivate` access lists |
| A player reads someone else's vote early | Votes live in `SeatPrivate`, readable only by that seat's registered keys until `settle` |
| Changing a vote or voting twice | `vote` enforces one vote per seat per round (`AlreadyVoted`, error `6011`), locking cards in the UI and rejecting second votes on-chain |
| Reading rollup logs to recover VRF output | Transactions touching private accounts return no readable data or logs to non-members; only `checkpoint` commits publicly |
| The operator chooses the insider | `on_random` accepts only `VRF_CALLBACK_IDENTITY` and active nonce, and mixes in every seated player's `sit` entropy |
| Replayed, duplicate, or late VRF callbacks | `Table` checks `Phase::Pending` and matches `nonce`; `start_round` allows retry only after `20` seconds |
| Operator freezes price updates | `tick`, `start_round`, and `settle` are permissionless, and every `trade` calls `refresh` |
| Fake or stale price feed | `oracle::read_price` verifies the Pyth Lazer account key, oracle program owner, `feed_id`, positive price, non-zero slot, and `30`-second freshness limit |
| Trading or voting for another seat | `trade` and `vote` verify the signer matches that seat's `wallet` or `session` key |
| Post-round draw tampering | `settle` publishes `revealed_salt`, and `rules.rs::draw_round` is a pure public function recomputable client-side |
| Idle player stalls a table | Between rounds the table authority can clear a seat via `stand` |

## Known limitations

- **Devnet only, play chips only.** No real SOL or token escrow is moved; all scores use table chips.
- **Trust in the TEE.** Privacy depends on MagicBlock's TEE validator and permission program; the browser does not verify a hardware attestation quote before authenticating.
- **Public timing.** Every trade timestamp hits the public tape and wall chart, which lets bots analyze trade timing faster than human players.
- **Guest keys in `localStorage`.** Browser guest keys are stored locally (clearing site storage drops the seat). `Player` profile PDAs (`init_player`, `cash_out`) exist in the program, while the web UI uses guest sessions only.
- **Operator-derived bot keys.** House bot keys in `scripts/house.ts` are derived from the operator key, so the operator can read bot seats, though it cannot read human seats or `Secret`.
- **Oracle exponent handling.** Because the devnet feed account stores a mismatched exponent value, `oracle.rs` interprets prices as 8 decimals directly from the Pyth Lazer SOL/USD feed layout.
- **Rollup testing environment.** Pure Rust logic, VRF draw properties, and oracle bounds are covered by 51 tests in `cargo test -p tipoff` ([`docs/TESTS.md`](docs/TESTS.md)), while rollup execution, permissions, and attacks are tested live against devnet via `scripts/round.ts`, `scripts/leak.ts`, and `scripts/attack.ts` ([`docs/ATTACKS.md`](docs/ATTACKS.md)) rather than a local validator.

## Repository

```
programs/tipoff/
  src/
    lib.rs       Anchor instructions, TEE permissions, VRF callback, Magic Action
    state.rs     Table (public), Secret & SeatPrivate (private), Player, Ledger
    rules.rs     draw_round, pricing, position limits, scoring, unit tests
    oracle.rs    Pyth Lazer SOL/USD feed validation and unit tests
  tests/
    invariants.rs  draw uniformity and proptest invariant suite
app/             React + Three.js web client (Vite)
docs/
  ATTACKS.md     live 11-attack devnet verification log and rule mapping
  TESTS.md       51-test Rust suite breakdown and fixed edge-case panics
  SUBMISSION.md  hackathon project descriptions and tech stack
  VIDEO.md       2:30 demo script and shot list
  screens/       desktop (1440x900) and phone (390x844) screenshots
scripts/
  lib.ts         shared devnet/TEE connections, PDAs, transaction sender
  round.ts       full devnet round with privacy checks and latency measurements
  attack.ts      live 11-cheat verification script against devnet table 7103
  provision.ts   creates and delegates the lobby tables and seals private accounts
  house.ts       fills tables with bots, starts rounds, ticks, settles, checkpoints
  guest.ts       unfunded guest player script for one round
  leak.ts        inspects rollup transaction visibility across caller keys
```

## Run it

```bash
# build Solana program & IDL and run Rust tests (51 tests)
anchor build --ignore-keys
cargo test -p tipoff

# install root script dependencies
npm install

# run the 11-attack suite against live devnet table 7103 (no funded key needed)
npm run attack

# play one unfunded guest round on devnet
npx tsx scripts/guest.ts

# run a full scripted round or host tables on devnet (needs funded key in keys/deployer.json)
npm run round
npm run provision
npm run house

# run the web client locally
cd app && npm install && npm run dev
```

Versions: Anchor `1.0.2`, `ephemeral-rollups-sdk` `0.18.0`, `ephemeral-vrf-sdk`, Solana devnet.
