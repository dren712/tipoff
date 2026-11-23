// The house: keeps the lobby tables running. It fills empty seats with bots once a human
// sits, requests the VRF draw, ticks the price, plays the bots, settles and checkpoints.
// It holds no special power over a round: every instruction it sends is permissionless or
// signed by a bot's own seat key, and it cannot read the sealed accounts.
//   npx tsx scripts/house.ts [tables] [hours]
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import crypto from "crypto";
import {
  FEED, FIRST_TABLE, QUEUE, ROUND_SECS, SEATS, VOTE_SECS, botKey, loadAdmin, perm, program, seatMetas, seatPda,
  send, sleep, tablePda, teeConn,
} from "./lib.js";

const INTERMISSION = 12; // seconds between a settlement and the next draw
const LOBBY_WAIT = 6; // seconds a new table waits for more humans
const admin = loadAdmin();
const count = Number(process.argv[2] ?? 4);
const hours = Number(process.argv[3] ?? 0);
const started = Date.now();
const now = () => Date.now() / 1000;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const zero = PublicKey.default;

type Bot = { kp: Keypair; conn: Connection; style: "momentum" | "fade" | "noise" | "holder"; nextAt: number; voted: boolean; plan?: any; seat: number };
type T = { id: number; key: PublicKey; bots: Bot[]; round: number; firstHuman: number; checkpointed: number; busy: boolean; idle: Map<string, number> };

let er = await teeConn(admin);
let pe = program(er, admin);
const tables: T[] = [];
const styles = ["momentum", "fade", "noise", "holder", "momentum", "noise"] as const;

async function connect() {
  er = await teeConn(admin);
  pe = program(er, admin);
  for (const t of tables) for (const b of t.bots) b.conn = await teeConn(b.kp);
}
for (let n = 0; n < count; n++) {
  const key = tablePda(FIRST_TABLE + n);
  const bots: Bot[] = [];
  for (let i = 0; i < SEATS; i++) {
    const kp = botKey(admin, key, i);
    bots.push({ kp, conn: er, style: styles[i], nextAt: 0, voted: false, seat: -1 });
  }
  tables.push({ id: FIRST_TABLE + n, key, bots, round: -1, firstHuman: 0, checkpointed: -1, busy: false, idle: new Map() });
}
await connect();
console.log(`house ${admin.publicKey.toBase58()} running ${count} tables`);

const botAt = (t: T, player: PublicKey) => t.bots.find((b) => b.kp.publicKey.equals(player));
const tx = (m: any) => m.transaction();

async function sit(t: T, b: Bot, i: number) {
  const seat = seatPda(t.key, i);
  await send(b.conn, await tx(program(b.conn, b.kp).methods.sit([...crypto.randomBytes(32)])
    .accountsPartial({ signer: b.kp.publicKey, player: null, table: t.key, seat, perm: perm(seat) })), [b.kp]);
}
async function stand(t: T, signer: Keypair, conn: Connection, i: number) {
  const seat = seatPda(t.key, i);
  await send(conn, await tx(program(conn, signer).methods.stand()
    .accountsPartial({ signer: signer.publicKey, player: null, table: t.key, seat, perm: perm(seat) })), [signer]);
}
async function trade(t: T, b: Bot, delta: number) {
  if (!delta) return;
  await send(b.conn, await tx(program(b.conn, b.kp).methods.trade(b.seat, delta)
    .accountsPartial({ signer: b.kp.publicKey, table: t.key, priceFeed: FEED })), [b.kp]);
}

/// Who a bot accuses: the seat whose trades best anticipated the shocks, with noise.
function suspect(s: any, me: number): number {
  const score = Array(SEATS).fill(0).map(() => rnd(0, 1.2));
  const n = Math.min(s.tapeLen, s.tape.length);
  for (let k = 0; k < n; k++) {
    const p = s.tape[k];
    for (const sh of s.shocks) {
      if (!sh.bps) continue;
      const lead = sh.at - p.t;
      if (lead > 0 && lead <= 9 && Math.sign(p.delta) === Math.sign(sh.bps)) score[p.seat] += Math.abs(p.delta) * 0.5;
      if (lead > 0 && lead <= 9 && Math.sign(p.delta) !== Math.sign(sh.bps)) score[p.seat] -= Math.abs(p.delta) * 0.25;
    }
  }
  score[me] = -1e9;
  return score.indexOf(Math.max(...score));
}

async function playBot(t: T, b: Bot, s: any, elapsed: number) {
  const seat = s.seats[b.seat];
  const clamp = (d: number) => Math.max(-5 - seat.pos, Math.min(5 - seat.pos, Math.round(d)));
  if (elapsed < ROUND_SECS - 1 && now() >= b.nextAt) {
    b.nextAt = now() + rnd(3, 9);
    if (b.plan === undefined) {
      // Only the bot's own key can read its seat. An insider bot gets its shocks here.
      const mine: any = await program(b.conn, b.kp).account.seatPrivate.fetch(seatPda(t.key, b.seat)).catch(() => null);
      b.plan = mine?.role === 2 && mine.round.eq(s.round) ? mine.shocks : null;
    }
    let d = 0;
    if (b.plan) {
      // Insider: position ahead of the next shock, sometimes late or small, to hide.
      const next = b.plan.find((x: any) => x.at > elapsed);
      if (next && next.at - elapsed < rnd(4, 12)) d = Math.sign(next.bps) * rnd(1, 4) - seat.pos * 0.5;
      else if (Math.random() < 0.3) d = rnd(-1.4, 1.4);
    } else {
      const last = [...s.shocks].filter((x: any) => x.bps && x.at <= elapsed).pop();
      const fresh = last && elapsed - last.at < 6;
      if (b.style === "momentum" && fresh) d = Math.sign(last.bps) * rnd(1, 3);
      else if (b.style === "fade" && fresh) d = -Math.sign(last.bps) * rnd(1, 3);
      else if (b.style === "holder") d = seat.trades === 0 ? (Math.random() < 0.5 ? 3 : -3) : Math.random() < 0.15 ? -Math.sign(seat.pos) : 0;
      else if (Math.random() < 0.6) d = rnd(-2.4, 2.4);
    }
    await trade(t, b, clamp(d));
  }
  if (!b.voted && elapsed > ROUND_SECS - rnd(2, 14)) {
    b.voted = true;
    await send(b.conn, await tx(program(b.conn, b.kp).methods.vote(suspect(s, b.seat))
      .accountsPartial({ signer: b.kp.publicKey, table: t.key, seat: seatPda(t.key, b.seat) })), [b.kp]);
  }
}

async function step(t: T) {
  const s: any = await pe.account.table.fetch(t.key);
  const humans = s.seats.filter((x: any) => !x.player.equals(zero) && !botAt(t, x.player));
  const elapsed = now() - s.tStart.toNumber();
  for (const b of t.bots) b.seat = s.seats.findIndex((x: any) => x.player.equals(b.kp.publicKey));

  if (s.phase === 1) {
    if (now() - s.requestedAt.toNumber() > 21) await start(t);
    return;
  }
  if (s.phase === 2) {
    if (elapsed >= ROUND_SECS + VOTE_SECS) {
      await send(er, await tx(pe.methods.settle().accountsPartial({ table: t.key }).remainingAccounts(seatMetas(t.key))), [admin]);
      console.log(`table ${t.id} round ${s.round} settled`);
      return;
    }
    if (t.round !== s.round.toNumber()) {
      t.round = s.round.toNumber();
      for (const b of t.bots) Object.assign(b, { plan: undefined, voted: false, nextAt: now() + rnd(1, 6) });
    }
    const jobs: Promise<any>[] = [send(er, await tx(pe.methods.tick().accountsPartial({ table: t.key, priceFeed: FEED })), [admin])];
    for (const b of t.bots) if (b.seat >= 0) jobs.push(playBot(t, b, s, elapsed));
    const res = await Promise.allSettled(jobs);
    for (const r of res) if (r.status === "rejected") console.log(`table ${t.id}: ${String(r.reason).slice(0, 160)}`);
    return;
  }

  // Idle or settled.
  const round = s.round.toNumber();
  if (s.phase === 3 && t.checkpointed !== round) {
    t.checkpointed = round;
    // Humans who neither traded nor voted for two rounds in a row lose their seat.
    for (let i = 0; i < SEATS; i++) {
      const x = s.seats[i];
      if (x.player.equals(zero) || botAt(t, x.player)) continue;
      const k = x.player.toBase58();
      const n = x.trades === 0 && s.votes[i] === 255 ? (t.idle.get(k) ?? 0) + 1 : 0;
      t.idle.set(k, n);
      if (n >= 2) { await stand(t, admin, er, i); t.idle.delete(k); console.log(`table ${t.id}: cleared idle seat ${i}`); }
    }
    const sig = await send(er, await tx(pe.methods.checkpoint().accountsPartial({ payer: admin.publicKey, table: t.key, authority: admin.publicKey })), [admin]);
    console.log(`table ${t.id} round ${round} checkpoint ${sig}`);
    return;
  }
  const since = s.phase === 3 ? now() - s.settledAt.toNumber() : 1e9;
  if (!humans.length) {
    t.firstHuman = 0;
    // An empty table keeps no bots, so every seat is open.
    for (const b of t.bots) if (b.seat >= 0) await stand(t, b.kp, b.conn, b.seat);
    return;
  }
  if (!t.firstHuman) t.firstHuman = now();
  // Between rounds one bot gives up its seat if the table is full, so a human can join.
  if (s.seats.every((x: any) => !x.player.equals(zero)) && since < INTERMISSION - 2) {
    const b = t.bots.find((x) => x.seat >= 0);
    if (b && since > 1) await stand(t, b.kp, b.conn, b.seat);
    return;
  }
  if (since < INTERMISSION || now() - t.firstHuman < LOBBY_WAIT) return;
  for (let i = 0; i < SEATS; i++) {
    if (!s.seats[i].player.equals(zero)) continue;
    const b = t.bots.find((x) => x.seat < 0);
    if (!b) break;
    await sit(t, b, i).catch((e) => console.log(`table ${t.id}: seat ${i} ${String(e).slice(0, 120)}`));
    b.seat = i;
  }
  await start(t);
}

async function start(t: T) {
  await send(er, await tx(pe.methods.startRound([...crypto.randomBytes(32)])
    .accountsPartial({ payer: admin.publicKey, table: t.key, priceFeed: FEED, oracleQueue: QUEUE }).remainingAccounts(seatMetas(t.key))), [admin]);
  console.log(`table ${t.id}: draw requested`);
}

let lastAuth = Date.now();
for (;;) {
  if (hours && Date.now() - started > hours * 3600_000) break;
  if (Date.now() - lastAuth > 20 * 60_000) { await connect().catch((e) => console.log("reconnect", String(e))); lastAuth = Date.now(); }
  for (const t of tables) {
    if (t.busy) continue;
    t.busy = true;
    step(t).catch((e) => console.log(`table ${t.id}: ${String(e).slice(0, 200)}`)).finally(() => (t.busy = false));
  }
  await sleep(1000);
}
