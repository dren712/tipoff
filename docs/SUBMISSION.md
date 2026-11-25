# Hackathon Submission

## Project Name

Tipoff

## One-Line Pitch

A 60-second Solana trading game where one secret insider knows the news early.

## 100-Word Description

Tipoff is a 60-second social deduction trading game built on Solana devnet and MagicBlock's Private Ephemeral Rollup. Six players share a live SOL/USD price while four hidden news shocks move the market. MagicBlock VRF selects one seat as the insider and reveals shock timing and direction only to that player's private account. Trades appear publicly on a 3D floor and confirm in 350 to 500 ms with zero fees and browser guest keys. After trading closes, everyone casts sealed accusations for 15 seconds to unmask the insider, then settles the scores and commits the round result back to Solana devnet.

## 300-Word Description

Tipoff is a multiplayer trading and deduction game built for Solana Blitz v10 using MagicBlock's Private Ephemeral Rollup on devnet. Six seats (Ruby, Amber, Rusty, Jade, Azure, and Violet) compete for play chips over 60-second rounds against a live Pyth Lazer SOL/USD price feed. During each round, four news shocks land in 12-second windows between 8 and 56 seconds, moving the price 0.8% to 2.5% up or down.

At round start, MagicBlock VRF inside the rollup selects one insider and four shocks, chaining randomness with entropy from every seated player. Only the insider's private seat account receives the shock schedule; the shared secret account allows zero readers, including the table operator. Players tap to buy or sell up to 5 lots long or short, where each lot represents 1,000 chips at the opening price. Every order confirms in 350 to 500 ms with no fee and no wallet popup using a browser guest key, stepping their 3D robot across the floor.

Because every trade appears on the public tape and floor, the insider must profit without tipping off the table. When the 60-second clock ends, trading stops and players have 15 seconds to cast a single sealed accusation into their private seat account. Votes stay hidden until settlement. Correct votes earn 100 chips and wrong votes lose 50. If at least two players give the insider the most votes outright, the insider loses their profit, pays a 100-chip fine, and splits gains among correct accusers; otherwise, their profit doubles.

Settlement reveals the salt so anyone can recompute the draw and commits the table to Solana devnet via a Magic Action, updating an on-chain ledger. An in-app proof drawer and an automated 11-attack script verify that private state stays hidden and invalid actions fail.

## How It Uses MagicBlock

- **Private Ephemeral Rollup (TEE) and Ephemeral Permissions**: `Secret` (holding the salt, insider index, and four shock timings) uses an empty permission access list so nobody, not even the table operator, can read it, while each `SeatPrivate` account restricts reads to that seat's wallet and session key on validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`.
- **VRF Inside the Rollup**: `start_round` requests MagicBlock VRF inside the TEE; the `on_random` callback enforces `VRF_CALLBACK_IDENTITY` and the active request nonce, chaining randomness with player-supplied sit entropy to derive the insider and shocks.
- **Oracle Price Feed**: `tick` and `trade` read the Pyth Lazer SOL/USD feed (`ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu`) republished on the rollup, checking feed address, oracle program owner, positive price, and a 30-second freshness limit.
- **Zero-Fee Execution and Guest Keys**: Seated players trade and vote inside the TEE using a browser-generated keypair (`localStorage`), confirming in about 350 to 500 ms with no transaction fee and no wallet popup.
- **Commit and Magic Action**: After settlement, `checkpoint` commits the `Table` account to Solana devnet and dispatches a `record_round` Magic Action to record the round number and state digest in the base-layer `Ledger` PDA.

## Tech Stack

- **On-Chain Program**: Rust, Anchor `1.0.2`, `ephemeral-rollups-sdk` `0.18.0`, `ephemeral-vrf-sdk`, `solana-sha256-hasher` `3`
- **Rollup and Oracle**: Solana devnet, MagicBlock Private Ephemeral Rollup (TEE), MagicBlock Ephemeral Permissions, MagicBlock VRF, MagicBlock Magic Actions, Pyth Lazer SOL/USD price feed
- **Web Client**: React `18.3.1`, TypeScript `5.6.0`, Vite `5.4.11`, Three.js `0.169.0`, `@coral-xyz/anchor` `0.32.1`, `@solana/web3.js` `^1.98.0`, `@magicblock-labs/ephemeral-rollups-sdk` `0.18.0`, `tweetnacl` `^1.0.3`
- **Scripts and Testing**: Node.js, `tsx` (`round.ts`, `house.ts`, `provision.ts`, `guest.ts`, `leak.ts`, `attack.ts`), Rust unit tests (`cargo test -p tipoff`)

## Links

- **Live URL**: https://dren712.github.io/tipoff/
- **Demo Video**: TODO
- **Source Repository**: https://github.com/dren712/tipoff
- **Devnet Program**: https://explorer.solana.com/address/BuxvayFhHgiWwvUtCofARcq9HcHzyvk5FPoGANsEw87M?cluster=devnet
- **Security Verification (`npm run attack`)**: [docs/ATTACKS.md](ATTACKS.md)
