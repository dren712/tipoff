# Demo video: 3:30 cut

Record at 1920x1080 in Chrome on a machine with a graphics card, sound on. Hide bookmarks and extensions. Record the clips below, then cut them to this script. Speak slowly; each line fits its slot at a normal pace.

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:12 | Lobby, 3D floor behind the headline. Slow push toward "Play now". | "Six traders. One live price. And one of them already knows the news." |
| 0:12–0:25 | Click **Play now** (or show the optional Phantom/Solflare wallet button). Seated in about three seconds; bots joining. | "Tipoff is a sixty-second trading game on Solana. No wallet, no fees—or connect Phantom or Solflare once to tie your season record to your wallet." |
| 0:25–0:40 | Role card: **Your role: Insider**. Then the tip-off banner counting down to the first shock. | "MagicBlock's randomness picks one insider inside a private rollup. This round, it's me. I'm the only one who knows when the four news shocks land, and which way they go." |
| 0:40–1:05 | Trading. Buy a few lots before the first shock; robot walks toward LONG, trade burst, the tape and wall chart update. Show the rollup chip ticking up moves at about 0.5 s and live **tell** chips appearing on seat tags. | "Every trade confirms in about half a second with zero fees. But every trade is also public. As shocks hit, seat tags light up with live tells—so if I trade right before the news, everyone sees it." |
| 1:05–1:25 | The rumour banner appears ("SOL to surge in 5"), then the shock hits: flash, shockwave, coins. | "Five seconds before each shock, a public rumour names a direction. It's right two times out of three. Only I know which rumours are lies. The shocks get bigger as the round goes on." |
| 1:25–1:40 | Last ten seconds: red pulse, closing bell. | "So the game for the insider is to profit without looking like the insider. The game for everyone else is to spot them." |
| 1:40–2:05 | Second round as a trader. Vote line-up, **Who was the insider?** Live tell chips, rank goal line, and evidence cards showing trades before each shock. Toggle all-in, accuse. | "Now I'm a trader. When the clock ends, everyone gets fifteen seconds to cast one sealed vote. The evidence cards show who traded just before each shock. Right is plus a hundred, wrong is minus fifty. All-in doubles the stakes." |
| 2:05–2:25 | Drum roll, showdown reveal: accusers charge in, **CAUGHT** cage slam (or **GOT AWAY** knockback and dance). Score count-up, **Case file** shock-by-shock breakdown, and Career bar with "Kept on Solana". | "The votes, the insider and the shocks are revealed together. Accusers rush the insider: catch them and split their profit; miss and they knock you back and double theirs. The Case file shows every tell afterwards, and results go to the season board on Solana." |
| 2:25–2:50 | Mid-round, open **Try to cheat**. Click **Read the secret**, **Read another seat**, **Trade as someone else**: each fails. | "Here's why it needs MagicBlock. On a normal chain, anyone could read the insider straight from the account data. Inside the private rollup, the secret has nobody on its read list. Not other players, not even me, the operator." |
| 2:50–3:05 | After settlement, **Verify the draw**: the browser recomputes the insider and shocks and shows a match. | "When the round ends, the salt is published, so anyone can recheck that the draw was fair." |
| 3:05–3:18 | Terminal: `npm run attack`, scrolling to `11/11 attacks rejected`. Then Solana Explorer on the program and season board. | "We ran eleven cheats against the live devnet tables. All eleven were rejected. And the results are committed back to Solana for anyone to inspect." |
| 3:18–3:30 | End card over the lobby: play link, repo link. | "Tipoff. Find the insider. Play free at tipoff-lake.vercel.app." |

On-screen captions (optional, one per shot): *No wallet, no fees* · *1 of 6 is the insider* · *~0.5 s per trade* · *Rumours: right 2 in 3* · *15 s sealed vote* · *Caught or got away* · *0 readers on the secret* · *Verify the draw* · *11/11 cheats rejected* · *tipoff-lake.vercel.app*

## Clips to record

1. **Lobby and join** (about 20 s): open the site, click Play now, wait until seated.
2. **Round as insider** (about 90 s): keep playing rounds until the role card says Insider. Trade before each shock, and keep recording through the vote and the reveal.
3. **Round as trader** (about 90 s): trade a little, then vote using the evidence cards. A round where the insider is caught makes the better shot.
4. **Try to cheat** (about 40 s): during a live round open the drawer and click each check; after the reveal click Verify the draw.
5. **Attack script** (about 20 s): in a terminal in the repo, `npm install` then `npm run attack`.
6. **Explorer** (about 15 s): the program and season board links from the README.

Tips: the insider role is random, one in six per round, so record a few rounds back to back and pick the best. If a moment is missed, the next round starts within about 15 s.
