import { Keypair } from "@solana/web3.js";
import { FIRST_TABLE, loadAdmin, secretPda, seatPda, tablePda, teeConn, QUEUE, PID } from "./lib.js";
const table = tablePda(FIRST_TABLE);
for (const [name, kp] of [["outsider", Keypair.generate()], ["admin", loadAdmin()]] as const) {
  const c = await teeConn(kp);
  for (const [n, a] of [["table", table], ["program", PID], ["queue", QUEUE]] as const) {
    const sigs = await c.getSignaturesForAddress(a, { limit: 25 }).catch(() => []);
    for (const s of sigs) {
      const tx = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (!tx) { console.log(name, n, "unreadable"); continue; }
      const m = tx.transaction.message;
      const keys = m.staticAccountKeys.map((k) => k.toBase58().slice(0, 4)).join(",");
      const ix = m.compiledInstructions.map((i) => `${m.staticAccountKeys[i.programIdIndex]?.toBase58().slice(0, 4)}:${Buffer.from(i.data).toString("hex").slice(0, 16)}/${i.data.length}`).join(" ");
      console.log(name, n, "logs", tx.meta?.logMessages?.length ?? 0, (tx.meta?.logMessages ?? []).filter((l) => l.includes("Instruction")).join("|").slice(0, 80), "keys", keys.slice(0, 60), "ix", ix.slice(0, 90));
    }
  }
}
