# Hackathon submission

## Project name

Tipoff

## One-line pitch

A 60-second trading game where one of six players secretly knows the news, and only a MagicBlock private rollup can keep that secret.

## 100-word description

Tipoff is a social deduction trading game on Solana. Six players trade a live SOL price for 60 seconds. One of them, picked by MagicBlock's verifiable randomness, secretly knows when four news shocks will hit. Everyone else watches the public trade tape and rumours for the tell, then casts one sealed vote: catch the insider and split their profit; miss, and the insider's profit doubles. The secret lives in a private rollup that nobody can read, not even the operator. Trades confirm in about half a second with no wallet and no fees, and results are committed back to Solana.

## 300-word description

Tipoff is a multiplayer trading and deduction game built for Solana Blitz v10 on MagicBlock's private Ephemeral Rollup.

Six players sit at a table straight from the browser, with no wallet and no fees; empty seats are filled by bots so a round starts within seconds. Players who want their season record tied to their wallet can connect Phantom or Solflare once; a session key then signs every move, so there are still no pop-ups. Tables with a SOL ante are planned for mainnet. Inside the private rollup, MagicBlock VRF picks one insider and four news shocks, mixing in randomness from every seated player. Only the insider learns when each shock lands and which way it goes.

For 60 seconds everyone trades the same price, which follows the live SOL/USD oracle at 12x. Each Buy or Sell confirms in about half a second and moves the player's robot along its lane on a 3D trading floor. Five seconds before each shock, a public rumour names a direction; it is right two times in three, and only the insider knows which rumours are lies. Every trade prints on the public tape, so the insider has to profit without being obvious.

When trading ends, each player gets 15 seconds to cast one sealed vote, using evidence cards that show who traded just before each shock. A normal accusation wins 100 or loses 50; all-in wins 200 or loses 150. If the insider is caught, they pay a 100-chip fine and their profit is shared among their accusers. If they escape, their profit doubles, and an insider who made no profit pays a 50-chip penalty.

Settlement reveals the insider, shocks and votes, and publishes the salt so anyone can recheck the draw in the browser. The table, a round ledger and a season board of human players' results are committed back to Solana. A live attack script shows 11 out of 11 cheats rejected on devnet, and the in-game Try to cheat drawer lets judges try the same thing.

## How it uses MagicBlock

- **Private Ephemeral Rollup (TEE) and permissions:** the account holding the insider and shocks has nobody on its read list, and each seat's private account (role, tip, vote) is readable only by that seat's keys.
- **VRF:** the insider and shocks are drawn from MagicBlock VRF inside the rollup; only the VRF program can deliver the randomness, and the draw can be rechecked after the round.
- **Oracle:** trades and price ticks read the SOL/USD feed inside the rollup, with owner, feed and 30-second freshness checks.
- **Zero-fee, sub-second execution:** players trade and vote with a browser guest key in about 0.5 s per move (median 520 ms in a scripted run).
- **Commits and Magic Actions:** after each round the table is committed to Solana and a Magic Action records the round in a ledger; the season board is committed after rounds with human players.

## Tech stack

- **Program:** Rust, Anchor 1.0.2, MagicBlock Ephemeral Rollups SDK 0.18.0, MagicBlock VRF SDK
- **MagicBlock / Solana:** devnet, private Ephemeral Rollup (TEE), permissions, VRF, Magic Actions, SOL/USD oracle feed
- **Web:** React 18, TypeScript, Three.js, Vite, hosted on GitHub Pages
- **Round runner and tests:** Node 20 scripts on GitHub Actions, Rust unit and property tests, a 2,000-round bot simulation, and a live devnet attack script

## Form checklist

- **Website:** https://tipoff-lake.vercel.app (mirror: https://dren712.github.io/tipoff/)
- **GitHub:** https://github.com/dren712/tipoff
- **Demo video:** VIDEO_URL_HERE
- **Program (devnet):** [`BuxvayFhHgiWwvUtCofARcq9HcHzyvk5FPoGANsEw87M`](https://explorer.solana.com/address/BuxvayFhHgiWwvUtCofARcq9HcHzyvk5FPoGANsEw87M?cluster=devnet)
- **Round ledger:** [`Dx1D48i2W3UTZpnJF1SxocVybbBDT73RjTVHycLvgcAu`](https://explorer.solana.com/address/Dx1D48i2W3UTZpnJF1SxocVybbBDT73RjTVHycLvgcAu?cluster=devnet)
- **Season board:** [`5QKFsaj9mwMrejYFtHeBHN9LMTZhbLTM5bt8SwLuAX6d`](https://explorer.solana.com/address/5QKFsaj9mwMrejYFtHeBHN9LMTZhbLTM5bt8SwLuAX6d?cluster=devnet)
- **Security log:** [docs/ATTACKS.md](ATTACKS.md)
- **Tests:** [docs/TESTS.md](TESTS.md)
