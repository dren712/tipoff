// Shared devnet plumbing for the scripts.
import anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAuthToken, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import fs from "fs";
import crypto from "crypto";

export const BASE = process.env.BASE_RPC ?? "https://rpc.magicblock.app/devnet";
export const TEE = process.env.TEE_RPC ?? "https://devnet-tee.magicblock.app";
export const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
export const MAGIC_FEE_VAULT = new PublicKey("EUJssY6kG5fb35s9Lc6jyh6joRPo2e2MhJqoKCqcTt5b");
export const FEED = new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
export const QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
export const SEATS = 6;
export const ROUND_SECS = 60;
export const VOTE_SECS = 15;
/// Public lobby tables are ids FIRST_TABLE .. FIRST_TABLE + n.
export const FIRST_TABLE = 7100;

export const idl = JSON.parse(fs.readFileSync(new URL("../app/src/idl/tipoff.json", import.meta.url), "utf8"));
export const PID = new PublicKey(idl.address);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const pda = (...s: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(s, PID)[0];
export const tablePda = (id: number) => pda(Buffer.from("table"), new anchor.BN(id).toArrayLike(Buffer, "le", 8));
export const secretPda = (table: PublicKey) => pda(Buffer.from("secret"), table.toBuffer());
export const seatPda = (table: PublicKey, i: number) => pda(Buffer.from("seat"), table.toBuffer(), Buffer.from([i]));
export const ledgerPda = () => pda(Buffer.from("ledger"));
export const boardPda = () => pda(Buffer.from("board"));
export const perm = (a: PublicKey) => ({ permission: permissionPdaFromAccount(a) });
export const seatMetas = (table: PublicKey) =>
  Array.from({ length: SEATS }, (_, i) => ({ pubkey: seatPda(table, i), isSigner: false, isWritable: false }));

/// The admin key: ADMIN_KEY (a JSON byte array) in CI, a keypair file locally.
export function loadAdmin(): Keypair {
  const raw = process.env.ADMIN_KEY ?? fs.readFileSync(process.env.WALLET ?? "keys/deployer.json", "utf8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/// House bots are derived from the admin key, so they need no storage.
export function botKey(admin: Keypair, table: PublicKey, i: number): Keypair {
  const seed = crypto.createHash("sha256").update(admin.secretKey).update(table.toBuffer()).update(Buffer.from([i])).digest();
  return Keypair.fromSeed(seed);
}

export function housePayer(admin: Keypair): Keypair {
  const seed = crypto.createHash("sha256").update("tipoff-house-payer").update(admin.secretKey).digest();
  return Keypair.fromSeed(seed);
}

export const base = new Connection(BASE, "confirmed");
export const program = (conn: Connection, kp: Keypair) =>
  new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" }));

export async function teeConn(kp: Keypair): Promise<Connection> {
  const { token } = await getAuthToken(TEE, kp.publicKey, async (m) => nacl.sign.detached(m, kp.secretKey));
  return new Connection(`${TEE}?token=${token}`, "confirmed");
}

const blockhashes = new Map<Connection, { hash: string; at: number }>();
async function blockhash(conn: Connection): Promise<string> {
  const c = blockhashes.get(conn);
  if (c && Date.now() - c.at < 10_000) return c.hash;
  const hash = (await conn.getLatestBlockhash()).blockhash;
  blockhashes.set(conn, { hash, at: Date.now() });
  return hash;
}

let salt = 0;
/// Sends and waits for the result. Throws with the on-chain error if the transaction fails.
export async function send(conn: Connection, tx: Transaction, signers: Keypair[], label?: string): Promise<string> {
  // A varying compute limit keeps repeated instructions (ticks) from being identical transactions.
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 + (salt = (salt + 1) % 100_000) }));
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = await blockhash(conn);
  tx.sign(...signers);
  const t0 = Date.now();
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`${label ?? "tx"} failed: ${JSON.stringify(st.err)} ${sig}`);
    if (st?.confirmationStatus) break;
    if (Date.now() - t0 > 30_000) throw new Error(`${label ?? "tx"} timed out ${sig}`);
    await sleep(conn === base ? 400 : 40);
  }
  if (label) console.log(`  ${label}: ${Date.now() - t0} ms  ${sig.slice(0, 16)}…`);
  return sig;
}
