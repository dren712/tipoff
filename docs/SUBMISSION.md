# Hackathon Submission

## Project Name

Tipoff

## One-Line Pitch

A 60-second trading game where one of six players secretly knows the news. If the shock list were readable, everyone would be the insider, so the game only works inside a MagicBlock private rollup.

## 100-Word Description

Tipoff is a 60-second social deduction trading game on Solana devnet using MagicBlock's Private Ephemeral Rollup. Six players trade a 12x SOL/USD feed while four news shocks move prices. MagicBlock VRF picks one insider, keeping shock schedules sealed inside private accounts and publishing a public rumour 5 seconds ahead of each shock. Orders confirm in about 0.5 s per move (median 520 ms in a scripted run) using zero fees and browser guest keys. After trading closes, players cast 15-second sealed or all-in accusations, settle scores, and commit the round and season board to Solana.

## 300-Word Description

Tipoff is a multiplayer trading and deduction game built for Solana Blitz v10 using MagicBlock's Private Ephemeral Rollup on devnet. Six seats (Ruby, Amber, Rusty, Jade, Azure, and Violet) compete for play chips over 60-second rounds against a live Pyth Lazer SOL/USD feed scaled at 12x leverage and clamped to +/-600 bps. During each round, four shocks land inside 12-second windows between 8 and 56 seconds (`0.8%` to `2.5%` in windows 1-2, `1.2%` to `3.75%` in window 3, `1.6%` to `5.0%` in window 4), preceded 5 seconds earlier by a public rumour matching two times in three.

At round start, MagicBlock VRF inside the rollup selects one insider, shocks, and rumours, chaining randomness with entropy from every seated player. Only the insider's private seat account receives the shock list; `Secret` allows zero readers, including the operator. Players tap Buy or Sell up to 5 lots long or short (`1,000` chips per lot at open). Orders confirm in about 0.5 s per move (median 520 ms in a scripted run) with zero fees and no wallet popups via a browser guest key, moving each 3D robot along its lane.

Because trades hit the public tape and back wall, the insider must profit without tipping off the floor. At 60 seconds, players get 15 seconds to cast one sealed vote (normal `+100`/`-50` or all-in `CONVICTION` `+200`/`-150`). If at least two accusers give the insider a strict plurality, the insider loses profits and pays a `100`-chip fine split among accusers; otherwise profits double (or zero/negative profit pays a `50`-chip blown-tip penalty). Settlement reveals the salt for local verification and commits `Table`, `Ledger`, and the `50`-entry `Board` back to Solana.

## How It Uses MagicBlock

- **Private Ephemeral Rollup (TEE) and Ephemeral Permissions**: `Secret` (holding the salt, insider index, and four shocks) uses an empty permission access list so nobody, not even the operator, can read it, while each `SeatPrivate` account restricts reads and writes to that seat's wallet and session key on validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`.
- **VRF Inside the Rollup**: `start_round` requests MagicBlock VRF inside the TEE; `on_random` enforces `VRF_CALLBACK_IDENTITY` and active nonce, chaining randomness with sit entropy to run `draw_round`.
- **Oracle Price Feed**: `tick` and `trade` read the Pyth Lazer SOL/USD feed (`ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu`) inside the rollup at `12x` (`+/-600` bps clamp), checking feed key, owner, non-zero slot, positive price, and a 30-second freshness limit.
- **Zero-Fee Execution and Guest Keys**: Seated players trade and cast normal or all-in votes inside the TEE using a browser keypair (`localStorage`), confirming in about 0.5 s per move (median 520 ms in a scripted run) with zero fees or wallet popups.
- **Commit and Magic Action**: After settlement, `checkpoint` commits `Table` to Solana devnet and dispatches `record_round` to `Ledger`, while `commit_board` commits the `50`-entry `Board` career standings to Solana.

## Tech Stack

- **On-Chain Program**: Rust, Anchor `1.0.2`, `ephemeral-rollups-sdk` `0.18.0`, `ephemeral-vrf-sdk`, `solana-sha256-hasher` `3`
- **Rollup and Oracle**: Solana devnet, MagicBlock Private Ephemeral Rollup (TEE), MagicBlock Ephemeral Permissions, MagicBlock VRF, MagicBlock Magic Actions, Pyth Lazer SOL/USD price feed
- **Web Client**: React `18.3.1`, TypeScript `5.6.0`, Vite `5.4.11`, Three.js `0.169.0`, `@coral-xyz/anchor` `0.32.1`, `@solana/web3.js` `^1.98.0`, `@magicblock-labs/ephemeral-rollups-sdk` `0.18.0`, `tweetnacl` `^1.0.3`
- **Scripts and Testing**: Node.js, `tsx` (`round.ts`, `house.ts`, `provision.ts`, `guest.ts`, `leak.ts`, `attack.ts`), Rust unit and invariant tests (`cargo test -p tipoff`)

## Form Checklist

- **Website**: https://dren712.github.io/tipoff/
- **GitHub**: https://github.com/dren712/tipoff
- **Pitch**: A 60-second trading game where one of six players secretly knows the news. If the shock list were readable, everyone would be the insider, so the game only works inside a MagicBlock private rollup.
- **Demo link**: VIDEO_URL_HERE
- **Integration proof (Solana Explorer)**: https://explorer.solana.com/address/BuxvayFhHgiWwvUtCofARcq9HcHzyvk5FPoGANsEw87M?cluster=devnet
- **Security verification log**: [docs/ATTACKS.md](ATTACKS.md)
- **Test breakdown**: [docs/TESTS.md](TESTS.md)
- **On-chain addresses (devnet)**:
  - Program: `BuxvayFhHgiWwvUtCofARcq9HcHzyvk5FPoGANsEw87M`
  - Ledger PDA (`ledger` seed): [`Dx1D48i2W3UTZpnJF1SxocVybbBDT73RjTVHycLvgcAu`](https://explorer.solana.com/address/Dx1D48i2W3UTZpnJF1SxocVybbBDT73RjTVHycLvgcAu?cluster=devnet)
  - Board PDA (`board` seed): `BOARD_ADDRESS_HERE`
