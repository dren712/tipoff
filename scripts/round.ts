// Plays one full Tipoff round on devnet: setup on Solana, delegation to the TEE rollup,
// VRF draw, trading, sealed votes, settlement, and the privacy checks.
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  getAuthToken,
  permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import fs from "fs";
import crypto from "crypto";
import { housePayer, MAGIC_FEE_VAULT } from "./lib.js";

const BASE = process.env.BASE_RPC ?? "https://rpc.magicblock.app/devnet";
const TEE = process.env.TEE_RPC ?? "https://devnet-tee.magicblock.app";
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const FEED = new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
const QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const SEATS = 6;

const idl = JSON.parse(fs.readFileSync("app/src/idl/tipoff.json", "utf8"));
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const admin = load(process.env.WALLET ?? "keys/deployer.json");
const commitPayer = housePayer(admin);
const PID = new PublicKey(idl.address);
const pda = (...s: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(s, PID)[0];

const base = new Connection(BASE, "confirmed");
const program = (conn: Connection, kp: Keypair) =>
  new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" }));

async function teeConn(kp: Keypair): Promise<Connection> {
  const { token } = await getAuthToken(TEE, kp.publicKey, async (m) => nacl.sign.detached(m, kp.secretKey));
  return new Connection(`${TEE}?token=${token}`, { commitment: "confirmed", wsEndpoint: `${TEE.replace("https", "wss")}?token=${token}` });
}

async function send(conn: Connection, tx: Transaction, signers: Keypair[], label: string): Promise<string> {
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(...signers);
  const t0 = Date.now();
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`${label} failed: ${JSON.stringify(st.err)} ${sig}`);
    if (st?.confirmationStatus) break;
    if (Date.now() - t0 > 60_000) throw new Error(`${label} timed out ${sig}`);
    await sleep(conn === base ? 400 : 20);
  }
  console.log(`  ${label}: ${Date.now() - t0} ms  ${sig.slice(0, 16)}…`);
  return sig;
}

async function main() {
  const id = new anchor.BN(process.env.TABLE_ID ?? Date.now());
  const table = pda(Buffer.from("table"), id.toArrayLike(Buffer, "le", 8));
  const secret = pda(Buffer.from("secret"), table.toBuffer());
  const seat = (i: number) => pda(Buffer.from("seat"), table.toBuffer(), Buffer.from([i]));
  const ledger = pda(Buffer.from("ledger"));
  const perm = (a: PublicKey) => ({ permission: permissionPdaFromAccount(a) });
  const players = Array.from({ length: SEATS }, () => Keypair.generate());
  const playerPda = (k: PublicKey) => pda(Buffer.from("player"), k.toBuffer());
  const pb = program(base, admin);
  console.log("program", PID.toBase58(), "table", table.toBase58());

  console.log("Solana: init + delegate");
  if (!(await base.getAccountInfo(ledger)))
    await send(base, await pb.methods.initLedger().accounts({ payer: admin.publicKey }).transaction(), [admin], "init_ledger");
  await send(base, await pb.methods.initTable(id, [...crypto.randomBytes(32)]).accounts({ authority: admin.publicKey }).transaction(), [admin], "init_table");
  for (let i = 0; i < SEATS; i += 3) {
    const tx = new Transaction();
    for (let j = i; j < i + 3; j++)
      tx.add(await pb.methods.initSeat(j).accountsPartial({ table, seat: seat(j), authority: admin.publicKey }).instruction());
    await send(base, tx, [admin], `init_seat ${i}-${i + 2}`);
  }
  for (const p of players) {
    const tx = new Transaction()
      .add(await pb.methods.initPlayer(p.publicKey).accountsPartial({ wallet: p.publicKey }).instruction())
      .add(await pb.methods.delegatePlayer().accountsPartial({ payer: admin.publicKey, wallet: p.publicKey, validator: TEE_VALIDATOR }).instruction());
    // The admin funds bot profiles; a real player pays for their own.
    tx.instructions.unshift(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: p.publicKey, lamports: 2_000_000 }));
    await send(base, tx, [admin, p], "init+delegate player");
  }
  await send(base, new Transaction()
    .add(await pb.methods.delegateSecret().accountsPartial({ payer: admin.publicKey, table, validator: TEE_VALIDATOR }).instruction())
    .add(await pb.methods.delegateTable(id).accountsPartial({ payer: admin.publicKey, validator: TEE_VALIDATOR }).instruction()),
    [admin], "delegate table+secret");
  for (let i = 0; i < SEATS; i += 3) {
    const tx = new Transaction();
    for (let j = i; j < i + 3; j++)
      tx.add(await pb.methods.delegateSeat(j).accountsPartial({ payer: admin.publicKey, table, pda: seat(j), validator: TEE_VALIDATOR }).instruction());
    await send(base, tx, [admin], `delegate_seat ${i}-${i + 2}`);
  }

  console.log("TEE rollup: seal, sit");
  const er = await teeConn(admin);
  const pe = program(er, admin);
  for (let n = 0; !(await er.getAccountInfo(table))?.owner.equals(PID); n++) {
    if (n > 60) throw new Error("table never appeared on the rollup");
    await sleep(500);
  }
  await send(er, await pe.methods.sealSecret().accountsPartial({ authority: admin.publicKey, table, perm: perm(secret) }).transaction(), [admin], "seal_secret");
  for (let i = 0; i < SEATS; i++)
    await send(er, await pe.methods.sealSeat().accountsPartial({ authority: admin.publicKey, table, seat: seat(i), perm: perm(seat(i)) }).transaction(), [admin], `seal_seat ${i}`);
  const conns = await Promise.all(players.map(teeConn));
  for (let i = 0; i < SEATS; i++)
    await send(conns[i], await program(conns[i], players[i]).methods.sit([...crypto.randomBytes(32)])
      .accountsPartial({ signer: players[i].publicKey, player: playerPda(players[i].publicKey), table, seat: seat(i), perm: perm(seat(i)) }).transaction(), [players[i]], `sit ${i}`);

  console.log("VRF draw");
  await send(er, await pe.methods.startRound([...crypto.randomBytes(32)]).accountsPartial({ payer: admin.publicKey, table, priceFeed: FEED, oracleQueue: QUEUE }).remainingAccounts(Array.from({ length: SEATS }, (_, i) => ({ pubkey: seat(i), isSigner: false, isWritable: false }))).transaction(), [admin], "start_round");
  const t0 = Date.now();
  let t: any;
  for (;;) {
    t = await pe.account.table.fetch(table);
    if (t.phase === 2) break;
    if (Date.now() - t0 > 60_000) throw new Error("VRF callback never arrived");
    await sleep(100);
  }
  console.log(`  callback after ${Date.now() - t0} ms, open price ${t.openPrice.toNumber() / 1e8}`);

  console.log("privacy checks during the round");
  const outsider = await teeConn(Keypair.generate());
  console.log("  outsider reads secret:", (await outsider.getAccountInfo(secret)) ? "LEAK" : "null");
  console.log("  admin reads secret:   ", (await er.getAccountInfo(secret)) ? "LEAK" : "null");
  console.log("  seat 1 reads seat 0:  ", (await conns[1].getAccountInfo(seat(0))) ? "LEAK" : "null");
  console.log("  base reads secret (stale, pre-draw):", (await pb.account.secret.fetch(secret).catch(() => null)) ? "readable" : "owned by delegation program");
  let insider = -1;
  for (let i = 0; i < SEATS; i++) {
    const s: any = await program(conns[i], players[i]).account.seatPrivate.fetch(seat(i));
    if (s.role === 2) { insider = i; console.log(`  seat ${i} sees: INSIDER, shocks`, s.shocks.map((x: any) => `${x.at}s ${x.bps}bps`).join(", ")); }
  }

  console.log("trading");
  const mine: any = await program(conns[insider], players[insider]).account.seatPrivate.fetch(seat(insider));
  const lat: number[] = [];
  const trade = async (i: number, d: number) => {
    const s = Date.now();
    await send(conns[i], await program(conns[i], players[i]).methods.trade(i, d).accountsPartial({ signer: players[i].publicKey, table, priceFeed: FEED }).transaction(), [players[i]], `trade seat ${i} ${d > 0 ? "+" : ""}${d}`);
    lat.push(Date.now() - s);
  };
  // The insider goes long before the first up-shock or short before the first down-shock.
  await trade(insider, mine.shocks[0].bps > 0 ? 5 : -5);
  for (let i = 0; i < SEATS; i++) if (i !== insider) await trade(i, i % 2 ? 2 : -2);
  for (let i = 0; i < SEATS; i++)
    await send(conns[i], await program(conns[i], players[i]).methods.vote((i + 1) % SEATS).accountsPartial({ signer: players[i].publicKey, table, seat: seat(i) }).transaction(), [players[i]], `vote ${i}`);
  console.log(`  median trade latency ${lat.sort((a, b) => a - b)[lat.length >> 1]} ms`);

  for (;;) {
    t = await pe.account.table.fetch(table);
    const left = t.tStart.toNumber() + 75 - Date.now() / 1000;
    if (left <= 0) break;
    await send(er, await pe.methods.tick().accountsPartial({ table, priceFeed: FEED }).transaction(), [admin], `tick (${left.toFixed(0)}s left, price ${t.price.toNumber() / 1e8}, shocks ${t.shocksSeen})`);
    await sleep(5000);
  }
  const rem = Array.from({ length: SEATS }, (_, i) => ({ pubkey: seat(i), isSigner: false, isWritable: false }));
  for (let n = 0; ; n++) {
    try { await send(er, await pe.methods.settle().accountsPartial({ table }).remainingAccounts(rem).transaction(), [admin], "settle"); break; }
    catch (e) { if (n > 5) throw e; await sleep(1000); }
  }
  t = await pe.account.table.fetch(table);
  console.log(`settled: insider seat ${t.insider} (private view said ${insider}), caught ${t.caught}`);
  console.log("  votes", t.votes, "scores", t.seats.map((s: any) => (s.last.toNumber() / 1e6).toFixed(1)));

  console.log("checkpoint to Solana");
  const sig = await send(er, await pe.methods.checkpoint().accountsPartial({
    payer: commitPayer.publicKey, table, authority: admin.publicKey, magicFeeVault: MAGIC_FEE_VAULT,
  }).transaction(), [commitPayer, admin], "checkpoint");
  await sleep(15000);
  const l: any = await pb.account.ledger.fetch(ledger);
  console.log("  ledger rounds", l.rounds.toString(), "last round", l.lastRound.toString(), "checkpoint tx", sig);
}

main().catch((e) => { console.error(e?.logs ?? "", e); process.exit(1); });
