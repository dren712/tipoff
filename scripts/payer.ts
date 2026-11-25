import { SystemProgram, Transaction } from "@solana/web3.js";
import { createDelegateInstruction, DELEGATION_PROGRAM_ID, lamportsDelegatedTransferIx } from "@magicblock-labs/ephemeral-rollups-sdk";
import crypto from "crypto";
import { base, housePayer, loadAdmin, send, teeConn, TEE_VALIDATOR } from "./lib.js";

const admin = loadAdmin();
const payer = housePayer(admin);
const requestedSol = process.argv[2] === undefined ? 0.5 : Number(process.argv[2]);
if (!Number.isFinite(requestedSol) || requestedSol <= 0) throw new Error("funding amount must be a positive number of SOL");
const requestedLamports = BigInt(Math.round(requestedSol * 1_000_000_000));
const info = await base.getAccountInfo(payer.publicKey);
const delegated = info?.owner.equals(DELEGATION_PROGRAM_ID) ?? false;

if (!delegated) {
  if (info && !info.owner.equals(SystemProgram.programId))
    throw new Error(`house payer has unexpected base owner ${info.owner.toBase58()}`);
  await send(base, new Transaction().add(SystemProgram.transfer({
    fromPubkey: admin.publicKey, toPubkey: payer.publicKey, lamports: Number(requestedLamports),
  })), [admin], "fund house payer");
  await send(base, new Transaction()
    .add(SystemProgram.assign({ accountPubkey: payer.publicKey, programId: DELEGATION_PROGRAM_ID }))
    .add(createDelegateInstruction({
      payer: admin.publicKey,
      delegatedAccount: payer.publicKey,
      ownerProgram: SystemProgram.programId,
      validator: TEE_VALIDATOR,
    })), [admin, payer], "delegate house payer");
} else if (process.argv[2] !== undefined) {
  await send(base, new Transaction().add(lamportsDelegatedTransferIx(
    admin.publicKey, payer.publicKey, requestedLamports, crypto.randomBytes(32),
  )), [admin], "top up house payer");
}

const er = await teeConn(admin);
const balance = await er.getBalance(payer.publicKey);
console.log(`house payer ${payer.publicKey.toBase58()} ER balance ${(balance / 1e9).toFixed(4)} SOL`);
