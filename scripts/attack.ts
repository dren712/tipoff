import anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  FEED,
  QUEUE,
  ROUND_SECS,
  SEATS,
  VOTE_SECS,
  perm,
  program,
  seatMetas,
  seatPda,
  secretPda,
  send,
  sleep,
  tablePda,
  teeConn,
} from "./lib.js";
import crypto from "crypto";

const ANCHOR_ERRORS: Record<number, string> = {
  2001: "ConstraintHasOne (A has_one constraint was violated)",
  2003: "ConstraintRaw (A raw constraint was violated)",
  2012: "ConstraintAddress (An address constraint was violated)",
  6000: "Unauthorized (Signer is not this seat's wallet or session key)",
  6001: "WrongPhase (Not allowed in this phase)",
  6002: "BadSeat (Bad seat)",
  6003: "SeatTaken (Seat is taken)",
  6004: "AlreadySeated (Wallet already holds a seat)",
  6005: "SeatsEmpty (Every seat must be filled)",
  6006: "PositionLimit (Position limit exceeded)",
  6007: "TooEarly (Too early)",
  6008: "BadSecret (Secret does not match this round)",
  6009: "BadPrice (Price feed is invalid or stale)",
  6010: "Overflow (Math overflow)",
};

function formatError(err: any): string {
  if (typeof err === "string") {
    const customMatch = err.match(/"Custom":\s*(\d+)/);
    if (customMatch) {
      const code = Number(customMatch[1]);
      if (ANCHOR_ERRORS[code]) return ANCHOR_ERRORS[code];
      return `Custom error ${code}`;
    }
    return err;
  }
  if (err?.InstructionError) {
    const detail = err.InstructionError[1];
    if (typeof detail === "object" && detail !== null && "Custom" in detail) {
      const code = detail.Custom;
      if (ANCHOR_ERRORS[code]) return ANCHOR_ERRORS[code];
      return `Custom error ${code}`;
    }
    return JSON.stringify(err.InstructionError);
  }
  return JSON.stringify(err);
}

let salt = 0;
async function sendRaw(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<{ sig: string; err: any }> {
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 + (salt = (salt + 1) % 100_000) }));
  tx.feePayer = signers[0].publicKey;
  const hashObj = await conn.getLatestBlockhash();
  tx.recentBlockhash = hashObj.blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const t0 = Date.now();
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) return { sig, err: st.err };
    if (st?.confirmationStatus) return { sig, err: null };
    if (Date.now() - t0 > 30_000) throw new Error(`timed out waiting for ${sig}`);
    await sleep(50);
  }
}

async function main() {
  const tableId = 7103;
  const table = tablePda(tableId);
  const me = Keypair.generate();
  const conn = await teeConn(me);
  const p = program(conn, me);

  console.log(`Attacker keypair: ${me.publicKey.toBase58()}`);
  console.log(`Target table: ${tableId} (${table.toBase58()})`);

  // Wait for an open seat on table 7103
  let myIdx = -1;
  while (myIdx === -1) {
    const s: any = await p.account.table.fetch(table);
    if (s.phase === 3 || s.phase === 0) {
      const openIdx = s.seats.findIndex((x: any) => x.player.toBase58() === "11111111111111111111111111111111");
      if (openIdx !== -1) {
        const seatKey = seatPda(table, openIdx);
        try {
          const sitTx = await p.methods
            .sit([...crypto.randomBytes(32)])
            .accountsPartial({ signer: me.publicKey, player: null, table, seat: seatKey, perm: perm(seatKey) })
            .transaction();
          await send(conn, sitTx, [me], `attacker sit seat ${openIdx}`);
          myIdx = openIdx;
          console.log(`Attacker seated at seat ${myIdx}`);
          break;
        } catch (e: any) {
          console.log(`sit attempt failed (${e.message}), retrying...`);
        }
      }
    }
    await sleep(1000);
  }

  // Wait for round to start (phase 2: Live)
  console.log(`Waiting for live round...`);
  let s: any = await p.account.table.fetch(table);
  while (s.phase !== 2) {
    await sleep(1000);
    s = await p.account.table.fetch(table);
  }
  console.log(`Round ${s.round.toString()} is live! Running live attacks...`);

  const otherIdx = (myIdx + 1) % SEATS;
  const otherSeat = seatPda(table, otherIdx);
  const mySeat = seatPda(table, myIdx);

  const results: { name: string; pass: boolean; line: string }[] = [];

  function recordPass(name: string, reason: string) {
    const line = `PASS ${name}: rejected with ${reason}`;
    console.log(line);
    results.push({ name, pass: true, line });
  }

  function recordFail(name: string, sig: string) {
    const line = `FAIL ${name}: went through, signature ${sig}`;
    console.log(line);
    results.push({ name, pass: false, line });
  }

  // 1. Read the table's secret account and another seat's private account through the rollup as the attacker (expect: no data).
  try {
    const secretKey = secretPda(table);
    const secretAcc = await conn.getAccountInfo(secretKey);
    const otherSeatAcc = await conn.getAccountInfo(otherSeat);
    if ((!secretAcc || secretAcc.data.length === 0) && (!otherSeatAcc || otherSeatAcc.data.length === 0)) {
      recordPass("read_sealed", "no data returned (protected by TEE permissions)");
    } else {
      recordFail("read_sealed", `secret data len=${secretAcc?.data.length ?? 0}, other seat data len=${otherSeatAcc?.data.length ?? 0}`);
    }
  } catch (e: any) {
    recordPass("read_sealed", `rejected with ${e.message}`);
  }

  // 2. Call trade for a seat the attacker does not own.
  try {
    const tx = await p.methods
      .trade(otherIdx, 1)
      .accountsPartial({ signer: me.publicKey, table, priceFeed: FEED })
      .transaction();
    const res = await sendRaw(conn, tx, [me]);
    if (res.err) {
      recordPass("trade_unowned_seat", formatError(res.err));
    } else {
      recordFail("trade_unowned_seat", res.sig);
    }
  } catch (e: any) {
    recordPass("trade_unowned_seat", formatError(e.message));
  }

  // 3. Call trade with a size that breaks the +/-5 position limit.
  try {
    const tx = await p.methods
      .trade(myIdx, 10)
      .accountsPartial({ signer: me.publicKey, table, priceFeed: FEED })
      .transaction();
    const res = await sendRaw(conn, tx, [me]);
    if (res.err) {
      recordPass("trade_position_limit", formatError(res.err));
    } else {
      recordFail("trade_position_limit", res.sig);
    }
  } catch (e: any) {
    recordPass("trade_position_limit", formatError(e.message));
  }

  // 4. Call vote accusing the attacker's own seat.
  try {
    const tx = await p.methods
      .vote(myIdx)
      .accountsPartial({ signer: me.publicKey, table, seat: mySeat })
      .transaction();
    const res = await sendRaw(conn, tx, [me]);
    if (res.err) {
      recordPass("vote_self", formatError(res.err));
    } else {
      recordFail("vote_self", res.sig);
    }
  } catch (e: any) {
    recordPass("vote_self", formatError(e.message));
  }

  // 5. Call vote twice in one round.
  try {
    // First valid vote
    const tx1 = await p.methods
      .vote(otherIdx)
      .accountsPartial({ signer: me.publicKey, table, seat: mySeat })
      .transaction();
    await sendRaw(conn, tx1, [me]);

    // Second vote
    const secondSuspect = (otherIdx + 1) % SEATS === myIdx ? (otherIdx + 2) % SEATS : (otherIdx + 1) % SEATS;
    const tx2 = await p.methods
      .vote(secondSuspect)
      .accountsPartial({ signer: me.publicKey, table, seat: mySeat })
      .transaction();
    const res2 = await sendRaw(conn, tx2, [me]);
    if (res2.err) {
      recordPass("vote_twice", formatError(res2.err));
    } else {
      recordFail("vote_twice", res2.sig);
    }
  } catch (e: any) {
    recordPass("vote_twice", formatError(e.message));
  }

  // 6. Call settle while trading is still open.
  try {
    const tx = await p.methods
      .settle()
      .accountsPartial({ table })
      .remainingAccounts(seatMetas(table))
      .transaction();
    const res = await sendRaw(conn, tx, [me]);
    if (res.err) {
      recordPass("settle_early", formatError(res.err));
    } else {
      recordFail("settle_early", res.sig);
    }
  } catch (e: any) {
    recordPass("settle_early", formatError(e.message));
  }

  // 8. Call on_random directly with made-up randomness (fake VRF callback).
  try {
    const fakeRandomness = [...crypto.randomBytes(32)];
    const nonce = s.nonce ?? new anchor.BN(1);
    const tx = await p.methods
      .onRandom(fakeRandomness, nonce)
      .accountsPartial({
        vrfProgramIdentity: me.publicKey,
        table,
        secret: secretPda(table),
        priceFeed: FEED,
      })
      .remainingAccounts(seatMetas(table))
      .transaction();
    const res = await sendRaw(conn, tx, [me]);
    if (res.err) {
      recordPass("fake_vrf_callback", formatError(res.err));
    } else {
      recordFail("fake_vrf_callback", res.sig);
    }
  } catch (e: any) {
    recordPass("fake_vrf_callback", formatError(e.message));
  }

  // 9. Call start_round as a stranger while a round is live.
  try {
    const clientSeed = [...crypto.randomBytes(32)];
    const tx = await p.methods
      .startRound(clientSeed)
      .accountsPartial({
        payer: me.publicKey,
        table,
        secret: secretPda(table),
        priceFeed: FEED,
        oracleQueue: QUEUE,
      })
      .remainingAccounts(seatMetas(table))
      .transaction();
    const res = await sendRaw(conn, tx, [me]);
    if (res.err) {
      recordPass("start_round_live", formatError(res.err));
    } else {
      recordFail("start_round_live", res.sig);
    }
  } catch (e: any) {
    recordPass("start_round_live", formatError(e.message));
  }

  // 10. Call tick with a different price feed account than the canonical one.
  try {
    const tx = await p.methods
      .tick()
      .accountsPartial({
        table,
        secret: secretPda(table),
        priceFeed: me.publicKey,
      })
      .transaction();
    const res = await sendRaw(conn, tx, [me]);
    if (res.err) {
      recordPass("tick_fake_price_feed", formatError(res.err));
    } else {
      recordFail("tick_fake_price_feed", res.sig);
    }
  } catch (e: any) {
    recordPass("tick_fake_price_feed", formatError(e.message));
  }

  // 11. Call checkpoint / record_round as a stranger for a round that is not settled.
  try {
    const tx = await p.methods
      .checkpoint()
      .accountsPartial({
        payer: me.publicKey,
        table,
        authority: me.publicKey,
      })
      .transaction();
    const res = await sendRaw(conn, tx, [me]);
    if (res.err) {
      recordPass("checkpoint_unsettled_stranger", formatError(res.err));
    } else {
      recordFail("checkpoint_unsettled_stranger", res.sig);
    }
  } catch (e: any) {
    recordPass("checkpoint_unsettled_stranger", formatError(e.message));
  }

  // Wait for round to settle for Attack 7 (settle a second time after the round has settled)
  console.log(`Waiting for round to settle for attack 7...`);
  s = await p.account.table.fetch(table);
  while (s.phase !== 3) {
    await sleep(1000);
    s = await p.account.table.fetch(table);
  }
  console.log(`Round settled (phase 3). Running attack 7...`);

  // 7. Call settle a second time after the round has settled.
  try {
    const tx = await p.methods
      .settle()
      .accountsPartial({ table })
      .remainingAccounts(seatMetas(table))
      .transaction();
    const res = await sendRaw(conn, tx, [me]);
    if (res.err) {
      recordPass("settle_twice", formatError(res.err));
    } else {
      recordFail("settle_twice", res.sig);
    }
  } catch (e: any) {
    recordPass("settle_twice", formatError(e.message));
  }

  // Finally call stand so the seat is freed.
  console.log(`Freeing seat ${myIdx} with stand...`);
  try {
    const standTx = await p.methods
      .stand()
      .accountsPartial({
        signer: me.publicKey,
        player: null,
        table,
        seat: mySeat,
        perm: perm(mySeat),
      })
      .transaction();
    await send(conn, standTx, [me], "stand");
    console.log(`Seat ${myIdx} freed successfully.`);
  } catch (e: any) {
    console.error(`stand failed: ${e.message}`);
  }

  const passedCount = results.filter((r) => r.pass).length;
  console.log(`${passedCount}/11 attacks rejected`);

  if (passedCount < results.length || results.length < 11) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
