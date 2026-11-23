// Creates the public lobby tables on Solana, delegates them to the TEE rollup and seals
// their private accounts. Safe to re-run: finished steps are skipped.
//   npx tsx scripts/provision.ts [count]
import anchor from "@coral-xyz/anchor";
import { Transaction } from "@solana/web3.js";
import crypto from "crypto";
import {
  FIRST_TABLE, PID, SEATS, TEE_VALIDATOR, base, ledgerPda, loadAdmin, perm, program, seatPda, secretPda,
  send, sleep, tablePda, teeConn,
} from "./lib.js";

const admin = loadAdmin();
const pb = program(base, admin);
const er = await teeConn(admin);
const pe = program(er, admin);
const count = Number(process.argv[2] ?? 4);

if (!(await base.getAccountInfo(ledgerPda())))
  await send(base, await pb.methods.initLedger().accounts({ payer: admin.publicKey }).transaction(), [admin], "init_ledger");

for (let n = 0; n < count; n++) {
  const id = FIRST_TABLE + n;
  const table = tablePda(id);
  const secret = secretPda(table);
  console.log(`table ${id} ${table.toBase58()}`);
  const info = await base.getAccountInfo(table);
  if (!info)
    await send(base, await pb.methods.initTable(new anchor.BN(id), [...crypto.randomBytes(32)]).accounts({ authority: admin.publicKey }).transaction(), [admin], "init_table");
  for (let i = 0; i < SEATS; i++)
    if (!(await base.getAccountInfo(seatPda(table, i))))
      await send(base, await pb.methods.initSeat(i).accountsPartial({ table, seat: seatPda(table, i), authority: admin.publicKey }).transaction(), [admin], `init_seat ${i}`);
  if (!info || info.owner.equals(PID)) {
    for (let i = 0; i < SEATS; i++)
      if ((await base.getAccountInfo(seatPda(table, i)))!.owner.equals(PID))
        await send(base, await pb.methods.delegateSeat(i).accountsPartial({ payer: admin.publicKey, table, pda: seatPda(table, i), validator: TEE_VALIDATOR }).transaction(), [admin], `delegate_seat ${i}`);
    // The table goes last: its owner on Solana marks the delegation as complete.
    const tx = new Transaction();
    if ((await base.getAccountInfo(secret))!.owner.equals(PID))
      tx.add(await pb.methods.delegateSecret().accountsPartial({ payer: admin.publicKey, table, validator: TEE_VALIDATOR }).instruction());
    tx.add(await pb.methods.delegateTable(new anchor.BN(id)).accountsPartial({ payer: admin.publicKey, validator: TEE_VALIDATOR }).instruction());
    await send(base, tx, [admin], "delegate secret+table");
  }
  for (let k = 0; !(await er.getAccountInfo(table))?.owner.equals(PID); k++) {
    if (k > 60) throw new Error("table never appeared on the rollup");
    await sleep(500);
  }
  // A sealed account is unreadable even to the admin; an unsealed one still is readable.
  if (await er.getAccountInfo(secret))
    await send(er, await pe.methods.sealSecret().accountsPartial({ authority: admin.publicKey, table, perm: perm(secret) }).transaction(), [admin], "seal_secret");
  for (let i = 0; i < SEATS; i++) {
    const seat = seatPda(table, i);
    if (await er.getAccountInfo(seat))
      await send(er, await pe.methods.sealSeat().accountsPartial({ authority: admin.publicKey, table, seat, perm: perm(seat) }).transaction(), [admin], `seal_seat ${i}`);
  }
}
console.log("done");
