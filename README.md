# Tipoff

**A 60-second trading game where one player secretly sees the news early, and everyone else has to work out who.**

Six traders share one live SOL/USD price. Four news shocks will hit it during the round. MagicBlock VRF secretly picks one seat as the insider and tells only that seat when each shock lands and which way. Every trade is public, so the insider has to profit without being obvious. When trading closes, everyone casts a sealed accusation.

Built for Solana Blitz v10 on MagicBlock's Private Ephemeral Rollup.

| | |
|---|---|
| Program (devnet) | [`BuxvayFhHgiWwvUtCofARcq9HcHzyvk5FPoGANsEw87M`](https://explorer.solana.com/address/BuxvayFhHgiWwvUtCofARcq9HcHzyvk5FPoGANsEw87M?cluster=devnet) |
| Rollup | MagicBlock devnet TEE validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` |
| Stakes | Play chips only. No tokens change hands. |

## Why this needs an Ephemeral Rollup

Tipoff cannot run on plain Solana, for two separate reasons:

1. **The game is a secret.** The insider's identity, the shock schedule and every vote must be hidden from all players, from the table operator and from anyone reading the chain, while the program still enforces the rules on them. On Solana every account is public. In the Private Ephemeral Rollup the accounts live inside a TEE and each one has an access list.
2. **The game is fast.** A round is 60 seconds of trading against a moving price. Trades confirm in about 350 to 500 ms with no fee and no wallet popup, measured from the browser and from `scripts/round.ts` (median 520 ms across 12 trades and 6 votes in one run).

Remove any one of the pieces below and the game stops working:

| MagicBlock piece | What it does in Tipoff | Without it |
|---|---|---|
| Private Ephemeral Rollup (TEE) | Holds the secret, each seat's role and each vote | Anyone could read who the insider is |
| Ephemeral permissions | Secret account: nobody may read. Seat account: only that seat's key | The operator could read the insider |
| VRF (inside the rollup) | Picks the insider and the four shocks | The operator could choose them |
| Price oracle | Live SOL/USD price that trades fill against | No market to trade |
| Zero-fee rollup transactions + guest keys | One-click trades, no wallet needed | A popup and a fee per trade |
| Commit + Magic Action | Each settled round is committed to Solana and recorded in a ledger account | Results would exist only in the rollup |

## How a round works

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
                                     vote:        written to the voter's private seat
                                     settle:      reveal insider, shocks, votes, salt
ledger: round recorded  ◄─────────   checkpoint:  commit table + Magic Action
```

- **Public** (`Table`): seats, positions, the trade tape, the current price, and after settlement the insider, shocks, votes and salt.
- **Private, nobody can read** (`Secret`): the salt, the insider and the shock schedule. Only the program uses it.
- **Private, one reader each** (`SeatPrivate`): the seat's role, the shocks if it is the insider, and its vote.

### Scoring

All amounts are chips. Each lot is worth 1,000 chips at the opening price and a seat can hold at most 5 lots long or short.

- Everyone keeps their trading profit or loss.
- A correct accusation earns 100. A wrong one costs 50. Not voting costs nothing.
- The insider is **caught** if they get at least two votes and strictly more than anyone else. They then lose their profit, pay a 100 fine, and the profit is split between the players who accused them.
- If the insider is not caught, their profit is doubled.

## Try to cheat

The web client has a "Try to cheat, then verify" panel. Each button sends a real request from your browser with your own key:

| Attempt | Result |
|---|---|
| Read the secret account from the rollup | Returns nothing. Its access list is empty |
| Read another seat's private account | Returns nothing. Only that seat's key may read it |
| Read the secret from Solana instead | Owned by the delegation program and frozen at its pre-game state |
| Trade from another seat | Rejected by the program: signer is not the seat's key |
| Verify the draw | After settlement the salt is revealed. The browser recomputes the insider and shocks from it and compares |
| Solana record | Explorer link to the latest round written to the ledger by the Magic Action |

`scripts/round.ts` runs the same read checks with three keys (an outsider, the table operator and a neighbouring seat) and `scripts/leak.ts` checks what transaction history each can see.

## Threat model

| Threat | Defence |
|---|---|
| A player reads the insider or shocks | `Secret` has an empty access list in the TEE. Verified from an outsider, the operator and a seated player |
| The operator reads the insider | Same. The table authority is not on any access list |
| A player reads someone's vote before settlement | Votes live in `SeatPrivate`, readable only by that seat |
| Reading transaction history to recover the VRF output | Transactions that touch a private account come back with no logs, keys or data, even for the operator. Only `checkpoint` is readable |
| The operator picks the insider | The draw comes from MagicBlock VRF. The callback only accepts the VRF program's signer for this program, and only for the current request nonce |
| The VRF oracle and operator collude | The salt also mixes in entropy supplied by every player when they sit |
| Replayed, duplicate or late VRF callbacks | The table tracks the request nonce and phase, so a second or stale callback is rejected |
| VRF never answers | Anyone can re-request after 20 seconds |
| The operator stops ticking to freeze the price | `tick`, `settle` and `start_round` are permissionless, and every trade refreshes the price itself |
| Fake or stale price feed | The feed address, owner program, feed id, positive price and a 30-second freshness limit are checked on every read |
| Trading as another seat | Each seat stores its wallet and session key. Trades and votes must be signed by one of them |
| A draw that was changed after the fact | The salt is revealed at settlement and the draw is a public function of it (`rules.rs::draw_round`) |
| An idle player blocks a table | The table authority can clear a seat between rounds |

## Known limitations

- **Devnet only, play chips only.** There is no token escrow, so nothing of value is at risk and none can be won.
- **Trust in the TEE.** Privacy rests on MagicBlock's TEE validator and its permission program. The client does not yet verify the TEE attestation quote before signing in.
- **Timing is visible.** The public tape shows when each seat trades. That is the game, but it also means a bot could play detective better than a person.
- **Guest keys live in the browser.** Clearing site data loses the seat. Profiles with a wallet and a session key exist in the program (`init_player`) but the web client only uses guest mode.
- **Bots are run by the house.** Bot keys are derived from the operator key, so the operator can read bot seats. It cannot read a human's seat. A human insider is hidden from the operator.
- **Oracle exponent.** The devnet feed account stores a wrong exponent, so the program treats the price as 8 decimals, as the feed list specifies.
- **Tests.** Rules are unit-tested (`cargo test`). Everything that touches the rollup is tested against devnet by `scripts/round.ts`, not in a local validator.

## Repository

```
programs/tipoff/src/
  lib.rs       instructions and account contexts
  state.rs     Table (public), Secret and SeatPrivate (private), Player, Ledger
  rules.rs     draw, pricing, position limits, scoring, with unit tests
  oracle.rs    SOL/USD feed validation
app/           React web client (Vite)
scripts/
  round.ts     one full round on devnet with privacy checks and timings
  provision.ts creates and delegates the lobby tables
  house.ts     seats bots, requests the draw, ticks, settles, checkpoints
  guest.ts     a wallet-less guest playing a round
  leak.ts      what each party can see of rollup transaction history
```

## Run it

```bash
# program
anchor build
cargo test -p tipoff

# a full round on devnet (needs a funded devnet key in keys/deployer.json)
npm install
npm run round

# lobby tables and the house
npm run provision
npm run house

# web client
cd app && npm install && npm run dev
```

Versions: Anchor 1.0.2, `ephemeral-rollups-sdk` 0.18.0, `ephemeral-vrf-sdk`, Solana devnet.
