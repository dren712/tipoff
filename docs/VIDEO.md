# Tipoff Demo Video Scripts

## 55-Second Cut (Shot Table)

| Time | What is on screen | Voice-over / Action | Caption |
| :--- | :--- | :--- | :--- |
| 0:00 - 0:06 | Lobby or floor opening over the six seated robots (`Ruby` to `Violet`) | "One of these six knows the news early." | One of these six knows the news early |
| 0:06 - 0:20 | Rumour slot flashes 5 s before the shock alongside the Insider `Tip-off` countdown banner; shock lands and trades move on tape | Show the public rumour, then the real shock landing while the insider front-runs cleanly with ~0.5 s confirmation (`520 ms` scripted median) | Rumour -> shock + Insider tip-off banner |
| 0:20 - 0:32 | At 60 s, the vote lineup appears with the per-shock evidence board; player casts an accusation (normal or all-in) | Inspect the evidence strip against each shock window and lock a sealed vote into `SeatPrivate` | Evidence board + sealed / all-in vote |
| 0:32 - 0:42 | Drum roll -> reveal spots the insider, drops the red cage (Punch x2 -> Sitting), and shows score deltas + `Board` update | Caught insider pays the 100-chip fine and splits profits across winning accusers | Caged reveal + round score breakdown |
| 0:42 - 0:50 | Open the `Try to cheat` drawer clicking `Read the secret` / `Read another seat` (refused), then switch to Explorer showing the committed `Board` / `Ledger` | Prove the rollup hides private accounts while base-layer settlement commits to Solana | Cheat drawer refuses reads + Explorer proof |
| 0:50 - 0:55 | End card with play URL, repo URL, and devnet program address | Close on playable guest link with zero wallet or fee needed | Play (no wallet): https://dren712.github.io/tipoff/ |

---

# 2:30 Cut

Target runtime: 2 minutes 30 seconds (`0:00` to `2:30`).

## Shot-by-Shot Script

| Time range | What is on screen | Voice-over line | On-screen caption |
| :--- | :--- | :--- | :--- |
| 0:00 - 0:10 | Tipoff lobby screen showing the orbiting 3D trading floor backdrop, the headline "Someone on this floor already knows the news.", and the four table cards. | Every market has someone trading ahead of the headline. What if that social deduction game lived on-chain? | Someone on this floor already knows the news. |
| 0:10 - 0:20 | Click "Play now" to enter a table. Camera frames the six-lane deck, the wall price chart, the LONG and SHORT gates, and the SEALED TEE vault. | Six traders share a live SOL price for sixty seconds while one secret insider sees four news shocks early. | 6 traders, 1 SOL/USD price, 60s, 4 shocks, 1 insider |
| 0:20 - 0:32 | "Dealing secret roles" finishes and the bell rings. The role card modal appears ("Your role: Insider"), then reveals the Tip-off countdown banner for the first shock. | You sit with a browser keypair, zero fees, and receive a private role card dealt inside the rollup. | Private role card dealt inside the TEE |
| 0:32 - 0:50 | Live trading floor. Clicking Buy/Sell (or pressing Up/Down keys) moves your robot along its lane toward LONG or SHORT up to 5 lots while trade markers hit the wall chart and trade tape updates. | Trades confirm in about 0.5 s per move (median 520 ms in a scripted run) with no wallet popups. Every position move is public. | ~0.5 s per move (520 ms median), +/-5 lot limit, public tape |
| 0:50 - 1:04 | A scheduled news shock hits (0.8% to 2.5%). The "Breaking" alert flashes, the deck tilts, a shockwave crosses the floor, winning robots fountain coins, and wrong-way 4+ lot robots fall down. | When a shock hits, the deck tilts, profits fly, and everyone studies the tape for who moved right beforehand. | News shock hits: watch who traded right before |
| 1:04 - 1:18 | At 60 seconds, trading closes and the 15-second voting timer starts. All six robots walk into a line-up under "Who was the insider?". Click one suspect to cast a sealed vote. | Trading ends at sixty seconds, and all six robots line up for fifteen seconds of sealed accusations. | 15s sealed vote: correct +100, wrong -50 |
| 1:18 - 1:32 | Drum roll, spotlight lands on the insider, and the verdict shows "Caught" (red cage drops, fined 100, profit split) or "Got away" (profit doubles) above the ranked scores. | After the drum roll, the insider is unmasked. If at least two players catch them, their profit splits. | Caught: 100 fine + split / Escaped: 2x profit |
| 1:32 - 1:43 | Open the "Try to cheat" drawer and click "Read the secret" and "Read another seat" during a round. Both return nothing from the rollup; "Read it from Solana" shows frozen delegated state. | Plain Solana exposes all account bytes. Inside MagicBlock TEE, the secret account allows zero readers, even the operator. | Secret account: 0 readers / SeatPrivate: owner only |
| 1:43 - 1:54 | Click "Verify the draw" in the "Try to cheat" drawer after settlement. The log recomputes the insider and four shocks from the revealed salt in the browser and confirms a match. | MagicBlock VRF picks the insider and shocks inside the rollup, mixed with player entropy and verified after settlement. | MagicBlock VRF + player entropy, verified from revealed salt |
| 1:54 - 2:04 | Show the "Read another seat" check failing during the 15-second voting window alongside the ballot tray showing only your own "Accused" tag. | Votes stay sealed in each player's private seat account until settlement, so nobody can copy or counter-vote early. | Votes sealed in SeatPrivate until settle |
| 2:04 - 2:15 | Terminal window running `npm run attack` (`scripts/attack.ts`) against devnet table 7103, scrolling through all 11 PASS lines to `11/11 attacks rejected`. | Our live attack script runs eleven cheats against devnet table 7103, and the program rejects all eleven. | npm run attack: 11/11 attacks rejected on devnet |
| 2:15 - 2:23 | Click "Solana record" in the "Try to cheat" drawer to open Solana Explorer on devnet, showing the committed round transaction, Magic Action call to `record_round`, and program `BuxvayFhHgiWwvUtCofARcq9HcHzyvk5FPoGANsEw87M`. | At settlement, a Magic Action commits the round hash and result to Solana's base layer for public proof. | Magic Action commits round to Solana devnet Ledger |
| 2:23 - 2:30 | Return to the Tipoff lobby view with an end card listing the program ID, repository URL, and live link placeholder. | Tipoff runs live on Solana devnet with no wallet required. Play a sixty-second round at the link below. | Play: dren712.github.io/tipoff / Code: github.com/dren712/tipoff |

## Exact Screen Recordings Needed

1. **Lobby backdrop clip (`1080p` browser capture, ~15s)**: Load the Tipoff web app at the lobby screen while at least one table is live so the 3D floor orbits behind the pitch and table list; click "Play now".
2. **Full round as Insider (`1080p` browser capture, ~90s)**: Sit at a table, wait through "Dealing secret roles", capture the "Your role: Insider" card and `Tip-off` banner, execute Buy/Sell trades before a news shock, capture the shock wave / deck tilt / coin fountain, cast a vote during the 15-second robot line-up, and record the drum roll, cage or dance reveal, and score strip.
3. **In-browser "Try to cheat" drawer clip (`1080p` browser capture, ~35s)**: During a live round (trading and voting), open the shield ("Try to cheat") drawer and click "Read the secret", "Read another seat", "Read it from Solana", and "Trade as someone else"; after settlement, click "Verify the draw" and "Solana record".
4. **Attack script terminal clip (`1080p` terminal capture, ~20s)**: Record running `npm run attack` against devnet table 7103 (with `docs/ATTACKS.md` or live terminal output showing all 11 checks printing `PASS` and `11/11 attacks rejected`).
5. **Solana Explorer devnet clip (`1080p` browser capture, ~15s)**: Capture the Solana Explorer devnet tab opened from "Solana record", showing the latest `checkpoint` / `record_round` transaction, the `Ledger` account, and program `BuxvayFhHgiWwvUtCofARcq9HcHzyvk5FPoGANsEw87M`.
6. **Closing lobby frame (`1080p` browser capture, ~10s)**: Clean capture of the lobby view for the closing card overlay with `https://dren712.github.io/tipoff/` and `https://github.com/dren712/tipoff`.
