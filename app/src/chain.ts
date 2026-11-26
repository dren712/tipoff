// Everything that talks to Solana and the MagicBlock TEE rollup.
import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAuthToken, permissionPdaFromAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { Buffer } from "buffer";
import idl from "./idl/tipoff.json";

export const BASE_RPC = "https://rpc.magicblock.app/devnet";
export const TEE_RPC = "https://devnet-tee.magicblock.app";
export const FEED = new PublicKey("ENYwebBThHzmzwPLAQvCucUTsjyfBSZdD9ViXksS4jPu");
export const PID = new PublicKey((idl as any).address);
export const SEATS = 6;
export const ROUND_SECS = 60;
export const VOTE_SECS = 15;
export const MAX_POS = 5;
export const NONE = 255;
export const FIRST_TABLE = 7100;
export const TABLES = 4;
export const LOT = 1e9;
export const LEVERAGE = 12;
export const CONVICTION = 8;
export const INTERMISSION = 15;
export const ZERO = PublicKey.default;

export const isRumour = (s: Pick<Shock, "bps">) => Math.abs(s.bps) === 1;
export const voteSeat = (v: number) => (v <= 5 || (v >= 8 && v <= 13) ? v % 8 : NONE);

const pda = (...s: (Uint8Array | Buffer)[]) => PublicKey.findProgramAddressSync(s, PID)[0];
export const tablePda = (id: number) => pda(Buffer.from("table"), new BN(id).toArrayLike(Buffer, "le", 8));
export const secretPda = (t: PublicKey) => pda(Buffer.from("secret"), t.toBuffer());
export const seatPda = (t: PublicKey, i: number) => pda(Buffer.from("seat"), t.toBuffer(), Buffer.from([i]));
export const ledgerPda = () => pda(Buffer.from("ledger"));
export const boardPda = () => pda(Buffer.from("board"));

export type Shock = { at: number; bps: number };
export type Seat = { player: PublicKey; session: PublicKey; pos: number; cash: BN; trades: number; last: BN; score: BN; rounds: number };
export type Print = { seat: number; delta: number; price: BN; t: number };
export type Table = {
  authority: PublicKey; id: BN; phase: number; round: BN; nonce: BN; requestedAt: BN; tStart: BN; settledAt: BN;
  openPrice: BN; oraclePrice: BN; price: BN; shockBps: number; shocksSeen: number; seats: Seat[]; tape: Print[];
  tapeLen: number; insider: number; caught: boolean; votes: number[]; shocks: Shock[]; revealedSalt: number[];
};
export type SeatPrivate = { table: PublicKey; idx: number; round: BN; role: number; shocks: Shock[]; vote: number };
export type BoardEntry = {
  player: PublicKey; score: BN; rounds: number; caught: number; escapes: number; streak: number; best: number;
};
export type Board = { bump: number; posted: BN[]; entries: BoardEntry[] };

/// The guest key lives in this browser only. It signs every move, so there are no wallet popups.
export function guestKey(): Keypair {
  const saved = localStorage.getItem("tipoff-key");
  if (saved) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved)));
  const kp = Keypair.generate();
  localStorage.setItem("tipoff-key", JSON.stringify([...kp.secretKey]));
  return kp;
}

const wallet = (kp: Keypair) => ({
  publicKey: kp.publicKey,
  signTransaction: async (tx: any) => (tx.partialSign(kp), tx),
  signAllTransactions: async (txs: any[]) => (txs.forEach((t) => t.partialSign(kp)), txs),
});

export type Session = { kp: Keypair; conn: Connection; program: Program<any> };

/// Signs the TEE's challenge and opens an authenticated connection to the private rollup.
export async function openSession(kp: Keypair): Promise<Session> {
  const { token } = await getAuthToken(TEE_RPC, kp.publicKey, async (m) => nacl.sign.detached(m, kp.secretKey));
  const conn = new Connection(`${TEE_RPC}?token=${token}`, "confirmed");
  return { kp, conn, program: new Program(idl as any, new AnchorProvider(conn, wallet(kp) as any, { commitment: "confirmed" })) };
}

export const base = new Connection(BASE_RPC, "confirmed");

const errors: Record<number, string> = Object.fromEntries(((idl as any).errors ?? []).map((e: any) => [e.code, e.msg ?? e.name]));
export function explain(err: any): string {
  const custom = err?.InstructionError?.[1]?.Custom;
  if (custom !== undefined) return errors[custom] ?? `program error ${custom}`;
  return typeof err === "string" ? err : JSON.stringify(err);
}

let hash = { value: "", at: 0 };
let salt = Math.floor(Math.random() * 50_000);
export type Sent = { sig: string; ms: number };

/// Sends a transaction signed by the guest key and waits for the rollup to confirm it.
export async function send(s: Session, tx: Transaction): Promise<Sent> {
  if (Date.now() - hash.at > 8_000) hash = { value: (await s.conn.getLatestBlockhash()).blockhash, at: Date.now() };
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 + (salt = (salt + 1) % 100_000) }));
  tx.feePayer = s.kp.publicKey;
  tx.recentBlockhash = hash.value;
  tx.sign(s.kp);
  const t0 = performance.now();
  const sig = await s.conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  for (;;) {
    const st = (await s.conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(explain(st.err));
    if (st?.confirmationStatus) return { sig, ms: Math.round(performance.now() - t0) };
    if (performance.now() - t0 > 20_000) throw new Error("The rollup did not confirm in time");
    await new Promise((r) => setTimeout(r, 30));
  }
}

const permFor = (a: PublicKey) => ({ permission: permissionPdaFromAccount(a) });
const entropy = () => [...crypto.getRandomValues(new Uint8Array(32))];

export const actions = {
  sit: async (s: Session, table: PublicKey, i: number) =>
    send(s, await s.program.methods.sit(entropy())
      .accountsPartial({ signer: s.kp.publicKey, player: null, table, seat: seatPda(table, i), perm: permFor(seatPda(table, i)) }).transaction()),
  stand: async (s: Session, table: PublicKey, i: number) =>
    send(s, await s.program.methods.stand()
      .accountsPartial({ signer: s.kp.publicKey, player: null, table, seat: seatPda(table, i), perm: permFor(seatPda(table, i)) }).transaction()),
  trade: async (s: Session, table: PublicKey, i: number, delta: number) =>
    send(s, await s.program.methods.trade(i, delta).accountsPartial({ signer: s.kp.publicKey, table, priceFeed: FEED }).transaction()),
  vote: async (s: Session, table: PublicKey, i: number, suspect: number) =>
    send(s, await s.program.methods.vote(suspect).accountsPartial({ signer: s.kp.publicKey, table, seat: seatPda(table, i) }).transaction()),
};

export async function fetchTable(s: Session, key: PublicKey): Promise<Table | null> {
  const info = await s.conn.getAccountInfo(key);
  return info ? (s.program.coder.accounts.decode("table", info.data) as Table) : null;
}

export async function fetchSeat(s: Session, table: PublicKey, i: number): Promise<SeatPrivate | null> {
  const info = await s.conn.getAccountInfo(seatPda(table, i));
  return info ? (s.program.coder.accounts.decode("seatPrivate", info.data) as SeatPrivate) : null;
}

export async function fetchBoard(s: Session): Promise<Board | null> {
  const info = await s.conn.getAccountInfo(boardPda()).catch(() => null);
  if (!info) return null;
  try {
    return s.program.coder.accounts.decode("board", info.data) as Board;
  } catch {
    return null;
  }
}

/// Chips won or lost so far by a seat, with its position marked at the current price.
export function equity(seat: Seat, price: number, open: number): number {
  if (!open) return 0;
  return (seat.cash.toNumber() + (seat.pos * LOT * price) / open) / 1e6;
}

/// Recomputes the round's draw from the salt revealed at settlement, exactly as the program
/// does (`rules.rs::draw_round`), so anyone can check the insider and shocks were not changed.
/// Test vector (salt = [0..32]): insider = 0, shocks =
/// [{ at: 10, bps: 249 }, { at: 31, bps: -171 }, { at: 43, bps: -319 }, { at: 51, bps: -240 }].
export async function redraw(saltBytes: number[]): Promise<{ insider: number; shocks: Shock[]; rumours: number[] }> {
  const data = new Uint8Array([...new TextEncoder().encode("tipoff-draw"), ...saltBytes]);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const shocks = Array.from({ length: 4 }, (_, i) => {
    const b = h.slice(1 + i * 4, 5 + i * 4);
    const raw = 80 + ((b[1] | (b[2] << 8)) % 171);
    const size = i === 2 ? Math.trunc((raw * 3) / 2) : i === 3 ? raw * 2 : raw;
    return { at: 8 + i * 12 + (b[0] % 12), bps: b[3] & 1 ? -size : size };
  });
  const rumours = shocks.map((s, i) => {
    const dir = s.bps > 0 ? 1 : -1;
    return h[17 + i] % 3 !== 0 ? dir : -dir;
  });
  return { insider: h[0] % SEATS, shocks, rumours };
}

export const short = (k: PublicKey | string) => { const s = k.toString(); return `${s.slice(0, 4)}…${s.slice(-4)}`; };
export const explorer = (kind: "tx" | "address", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=devnet`;
