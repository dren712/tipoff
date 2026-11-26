// The house: keeps the lobby tables running. It fills empty seats with bots once a human
// sits, requests the VRF draw, ticks the price, plays the bots, settles and checkpoints.
// It holds no special power over a round: every instruction it sends is permissionless or
// signed by a bot's own seat key, and it cannot read the sealed accounts.
//   npx tsx scripts/house.ts [tables] [hours]
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { lamportsDelegatedTransferIx } from "@magicblock-labs/ephemeral-rollups-sdk";
import crypto from "crypto";
import {
  FEED, FIRST_TABLE, INTERMISSION, LOBBY_WAIT, MAGIC_FEE_VAULT, QUEUE, ROUND_SECS, SEATS, VOTE_SECS, base, botKey,
  housePayer as deriveHousePayer, loadAdmin, perm, program, seatMetas, seatPda, send, sleep, tablePda, teeConn,
} from "./lib.js";
import {
  BotRoundState, decideTrade, decideVote, initBotRound, observeTable, shuffleStyles, toTableView,
} from "./bots.js";

const admin = loadAdmin();
const housePayer = deriveHousePayer(admin);
const count = Number(process.argv[2] ?? 4);
const hours = Number(process.argv[3] ?? 0);
const started = Date.now();
const now = () => Date.now() / 1000;
const zero = PublicKey.default;
async function topUpPayer() {
  try {
    const before = await er.getBalance(housePayer.publicKey);
    console.log(`house payer ER balance before top-up check ${(before / 1e9).toFixed(4)} SOL`);
    if (before < 150_000_000) {
      const adminBalance = await base.getBalance(admin.publicKey);
      if (adminBalance > 600_000_000) {
        await send(base, new Transaction().add(lamportsDelegatedTransferIx(
          admin.publicKey, housePayer.publicKey, 300_000_000n, crypto.randomBytes(32),
        )), [admin], "top up house payer");
      } else {
        console.warn(`house payer top-up skipped: admin balance ${(adminBalance / 1e9).toFixed(4)} SOL`);
      }
    }
  } catch (e) {
    console.log(`house payer top-up failed: ${String(e).slice(0, 200)}`);
  }
  try {
    const after = await er.getBalance(housePayer.publicKey);
    console.log(`house payer ER balance after top-up check ${(after / 1e9).toFixed(4)} SOL`);
  } catch (e) {
    console.log(`house payer after-balance check failed: ${String(e).slice(0, 200)}`);
  }
}

type Bot = { kp: Keypair; conn: Connection; state: BotRoundState; nextAt: number; plan?: any; seat: number };
type T = { id: number; key: PublicKey; bots: Bot[]; round: number; firstHuman: number; checkpointed: number; lastCheckpointAt: number; busy: boolean; idle: Map<string, number> };

let er = await teeConn(admin);
let pe = program(er, admin);
let lastBoardCommitAt = 0;
const tables: T[] = [];

async function connect() {
  er = await teeConn(admin);
  pe = program(er, admin);
  for (const t of tables) for (const b of t.bots) b.conn = await teeConn(b.kp);
}
for (let n = 0; n < count; n++) {
  const key = tablePda(FIRST_TABLE + n);
  const bots: Bot[] = [];
  const styles = shuffleStyles(Math.random, SEATS);
  for (let i = 0; i < SEATS; i++) {
    const kp = botKey(admin, key, i);
    bots.push({ kp, conn: er, state: initBotRound(i, styles[i], Math.random), nextAt: 0, seat: -1 });
  }
  tables.push({ id: FIRST_TABLE + n, key, bots, round: -1, firstHuman: 0, checkpointed: -1, lastCheckpointAt: 0, busy: false, idle: new Map() });
}
await connect();
const LIVE_TABLES = Number(process.env.LIVE_TABLES ?? 1);
console.log(`house ${admin.publicKey.toBase58()} running ${count} tables`);
await topUpPayer();
setInterval(() => { void topUpPayer(); }, 10 * 60 * 1000);

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

async function playBot(t: T, b: Bot, s: any, view: ReturnType<typeof toTableView>, elapsed: number) {
  b.state.seat = b.seat;
  observeTable(b.state, view, elapsed);
  if (elapsed < ROUND_SECS - 1 && now() >= b.nextAt) {
    b.nextAt = now() + 1;
    if (b.plan === undefined) {
      // Only the bot's own key can read its seat. An insider bot gets its shocks here.
      const mine: any = await program(b.conn, b.kp).account.seatPrivate.fetch(seatPda(t.key, b.seat)).catch(() => null);
      b.plan = mine?.role === 2 && mine.round.eq(s.round) ? mine.shocks : null;
    }
    const delta = decideTrade(view, b.state, b.plan, elapsed, Math.random);
    await trade(t, b, delta);
  }
  const suspect = decideVote(view, b.state, elapsed, Math.random, process.env.ALLIN !== "0");
  if (suspect !== null) {
    await send(b.conn, await tx(program(b.conn, b.kp).methods.vote(suspect)
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
      const styles = shuffleStyles(Math.random, SEATS);
      t.bots.forEach((b, i) => {
        Object.assign(b, { plan: undefined, nextAt: now() + 1, state: initBotRound(b.seat, styles[i], Math.random) });
      });
    }
    const view = toTableView(s, zero);
    const jobs: Promise<any>[] = [send(er, await tx(pe.methods.tick().accountsPartial({ table: t.key, priceFeed: FEED })), [admin])];
    for (const b of t.bots) if (b.seat >= 0) jobs.push(playBot(t, b, s, view, elapsed));
    const res = await Promise.allSettled(jobs);
    for (const r of res) if (r.status === "rejected") console.log(`table ${t.id}: ${String(r.reason).slice(0, 160)}`);
    return;
  }

  // Idle or settled.
  const round = s.round.toNumber();
  if (s.phase === 3 && t.checkpointed !== round) {
    t.checkpointed = round;
    let mask = 0;
    for (let i = 0; i < SEATS; i++) {
      const x = s.seats[i];
      if (!x.player.equals(zero) && !botAt(t, x.player)) mask |= 1 << i;
    }
    // Humans who neither traded nor voted for two rounds in a row lose their seat.
    for (let i = 0; i < SEATS; i++) {
      const x = s.seats[i];
      if (x.player.equals(zero) || botAt(t, x.player)) continue;
      const k = x.player.toBase58();
      const n = x.trades === 0 && s.votes[i] === 255 ? (t.idle.get(k) ?? 0) + 1 : 0;
      t.idle.set(k, n);
      if (n >= 2) { await stand(t, admin, er, i); t.idle.delete(k); console.log(`table ${t.id}: cleared idle seat ${i}`); }
    }
    if (mask !== 0 || now() - t.lastCheckpointAt >= 15 * 60) {
      try {
        const sig = await send(er, await tx(pe.methods.checkpoint().accountsPartial({
          payer: housePayer.publicKey, table: t.key, authority: admin.publicKey, magicFeeVault: MAGIC_FEE_VAULT,
        })), [housePayer, admin]);
        t.lastCheckpointAt = now();
        console.log(`table ${t.id} round ${round} checkpoint ${sig}`);
      } catch (e) {
        console.log(`table ${t.id} round ${round} checkpoint failed: ${String(e).slice(0, 160)}`);
      }
    } else {
      console.log(`table ${t.id} round ${round} checkpoint skipped (no human players; 15-minute heartbeat not due)`);
    }
    try {
      const postSig = await send(er, await tx(pe.methods.postRound(mask).accountsPartial({ authority: admin.publicKey, table: t.key })), [admin]);
      console.log(`table ${t.id} round ${round} post_round ${postSig}`);
    } catch (e) {
      console.log(`table ${t.id} round ${round} post_round failed: ${String(e).slice(0, 160)}`);
    }
    if (mask !== 0 && now() - lastBoardCommitAt >= 60) {
      try {
        const commitSig = await send(er, await tx(pe.methods.commitBoard().accountsPartial({
          payer: housePayer.publicKey, table: t.key, authority: admin.publicKey, magicFeeVault: MAGIC_FEE_VAULT,
        })), [housePayer, admin]);
        lastBoardCommitAt = now();
        console.log(`table ${t.id} round ${round} commit_board ${commitSig}`);
      } catch (e) {
        console.log(`table ${t.id} round ${round} commit_board failed: ${String(e).slice(0, 160)}`);
      }
    } else {
      console.log(`table ${t.id} round ${round} commit_board skipped (${mask === 0 ? "no human players" : "60-second rate limit"})`);
    }
    return;
  }
  const since = s.phase === 3 ? now() - s.settledAt.toNumber() : 1e9;
  // The first tables always run, so there is a live game to watch and steady on-chain activity.
  const live = t.id - FIRST_TABLE < LIVE_TABLES;
  if (!humans.length && live && !t.firstHuman) t.firstHuman = now() - LOBBY_WAIT;
  if (!humans.length && !live) {
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
