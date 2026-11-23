// A guest player with a fresh, unfunded key: sits at a lobby table and plays one round.
//   npx tsx scripts/guest.ts [tableIndex]
import { Keypair } from "@solana/web3.js";
import crypto from "crypto";
import { FEED, FIRST_TABLE, perm, program, seatPda, send, sleep, tablePda, teeConn } from "./lib.js";

const me = Keypair.generate();
const conn = await teeConn(me);
const p = program(conn, me);
const table = tablePda(FIRST_TABLE + Number(process.argv[2] ?? 0));
let s: any = await p.account.table.fetch(table);
const idx = s.seats.findIndex((x: any) => x.player.toBase58() === "11111111111111111111111111111111");
const seat = seatPda(table, idx);
await send(conn, await p.methods.sit([...crypto.randomBytes(32)]).accountsPartial({ signer: me.publicKey, player: null, table, seat, perm: perm(seat) }).transaction(), [me], `guest ${me.publicKey.toBase58().slice(0, 6)} sits in seat ${idx}`);
let traded = 0, voted = false, last = "";
for (;;) {
  s = await p.account.table.fetch(table);
  const el = Date.now() / 1000 - s.tStart.toNumber();
  const line = `phase ${s.phase} round ${s.round} seats ${s.seats.filter((x: any) => x.trades > 0).length} trading, tape ${s.tapeLen}, price ${(s.price.toNumber() / 1e8).toFixed(3)}, shocks ${s.shocksSeen}`;
  if (line !== last) console.log(line), (last = line);
  if (s.phase === 2 && el < 55 && traded < 3 && el > traded * 15) {
    traded++;
    const mine: any = await p.account.seatPrivate.fetch(seat);
    console.log(`  my role ${mine.role === 2 ? "INSIDER" : "trader"}`);
    await send(conn, await p.methods.trade(idx, traded % 2 ? 2 : -1).accountsPartial({ signer: me.publicKey, table, priceFeed: FEED }).transaction(), [me], "trade");
  }
  if (s.phase === 2 && el > 50 && !voted) {
    voted = true;
    await send(conn, await p.methods.vote((idx + 1) % 6).accountsPartial({ signer: me.publicKey, table, seat }).transaction(), [me], "vote");
  }
  if (s.phase === 3 && voted) break;
  await sleep(1000);
}
console.log("insider", s.insider, "caught", s.caught, "votes", s.votes, "scores", s.seats.map((x: any) => (x.last.toNumber() / 1e6).toFixed(1)), "my seat", idx);
