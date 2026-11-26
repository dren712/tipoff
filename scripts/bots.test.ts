import assert from "assert";
import crypto from "crypto";
import { CONVICTION, SEATS } from "./lib.js";
import {
  BotRoundState,
  ShockView,
  TableView,
  decideTrade,
  decideVote,
  initBotRound,
  mulberry32,
  observeTable,
  shuffleStyles,
} from "./bots.js";

function drawRound(salt: Buffer): { insider: number; shocks: ShockView[]; rumours: number[] } {
  const h = crypto.createHash("sha256").update(Buffer.from("tipoff-draw")).update(salt).digest();
  const shocks: ShockView[] = [];
  const rumours: number[] = [];
  for (let i = 0; i < 4; i++) {
    const b = h.subarray(1 + i * 4, 5 + i * 4);
    const raw = 80 + ((b[1] | (b[2] << 8)) % 171);
    const size = i === 2 ? Math.trunc((raw * 3) / 2) : i === 3 ? raw * 2 : raw;
    const at = 8 + i * 12 + (b[0] % 12);
    const bps = b[3] & 1 ? -size : size;
    shocks.push({ at, bps });
    const dir = bps > 0 ? 1 : -1;
    rumours.push(h[17 + i] % 3 !== 0 ? dir : -dir);
  }
  return { insider: h[0] % SEATS, shocks, rumours };
}

const decodeSeat = (v: number): number | null => (v <= 5 || (v >= 8 && v <= 13) ? v % 8 : null);

const ROUNDS = 2000;
const rng = mulberry32(0x12345678);
let caughtCount = 0;
let unanimousCount = 0;

for (let r = 0; r < ROUNDS; r++) {
  const salt = Buffer.alloc(32);
  salt.writeUInt32LE(r, 0);
  salt.writeUInt32LE((r ^ 0x9e3779b9) >>> 0, 4);
  const draw = drawRound(salt);

  const openPrice = 150_00000000;
  const table: TableView = {
    price: openPrice,
    openPrice,
    seats: Array.from({ length: SEATS }, () => ({ pos: 0, trades: 0, empty: false })),
    tape: [],
    shocks: Array.from({ length: 4 }, () => ({ at: 0, bps: 0 })),
  };

  const styles = shuffleStyles(rng, SEATS);
  const states: BotRoundState[] = Array.from({ length: SEATS }, (_, i) => initBotRound(i, styles[i], rng));
  const votes: Array<number | null> = Array(SEATS).fill(null);
  let shockBps = 0;
  let oracleDelta = 0;

  for (let t = 0; t <= 74; t++) {
    // Small random oracle drift each second (12x levered).
    oracleDelta += (rng() - 0.5) * 0.0008;
    const leveredMove = Math.max(-0.06, Math.min(0.06, oracleDelta * 12));

    shockBps = 0;
    for (let i = 0; i < 4; i++) {
      const sh = draw.shocks[i];
      if (t >= sh.at) {
        table.shocks[i] = { at: sh.at, bps: sh.bps };
        shockBps += sh.bps;
      } else if (t >= sh.at - 5) {
        table.shocks[i] = { at: sh.at, bps: draw.rumours[i] };
      }
    }
    table.price = Math.round(openPrice * (1 + leveredMove) * (1 + shockBps / 10000));

    for (let i = 0; i < SEATS; i++) {
      observeTable(states[i], table, t);
      if (t < 60) {
        const plan = i === draw.insider ? draw.shocks : null;
        const delta = decideTrade(table, states[i], plan, t, rng);
        if (delta !== 0) {
          const nextPos = table.seats[i].pos + delta;
          assert.ok(Math.abs(nextPos) <= 5, `seat ${i} exceeded +-5 limit: ${nextPos}`);
          if (i === draw.insider) {
            assert.ok(Math.abs(nextPos) <= 4, `insider exceeded +-4 limit: ${nextPos}`);
          }
          table.seats[i].pos = nextPos;
          table.seats[i].trades += 1;
          table.tape.push({ seat: i, delta, t });
        }
      }
      const v = decideVote(table, states[i], t, rng, true);
      if (v !== null) {
        assert.ok(t >= 61, `vote produced before 61s at t=${t}`);
        const target = decodeSeat(v);
        assert.ok(target !== null && target >= 0 && target < SEATS, `invalid vote byte ${v}`);
        if (i === draw.insider) {
          assert.notStrictEqual(target, draw.insider, "insider bot voted for itself");
        }
        votes[i] = target;
      }
    }
  }

  // Tally votes using program rules (own vote ignored).
  const tally = Array(SEATS).fill(0);
  const voterTargets: number[] = [];
  for (let i = 0; i < SEATS; i++) {
    const target = votes[i];
    if (i !== draw.insider && target !== null) {
      tally[target] += 1;
    }
    if (target !== null) voterTargets.push(target);
  }
  const insiderVotes = tally[draw.insider];
  const caught = insiderVotes >= 2 && tally.every((c, idx) => idx === draw.insider || c < insiderVotes);
  if (caught) caughtCount += 1;

  if (voterTargets.length > 0 && voterTargets.every((x) => x === voterTargets[0])) {
    unanimousCount += 1;
  }
}

const catchRate = (caughtCount / ROUNDS) * 100;
const unanimityRate = (unanimousCount / ROUNDS) * 100;
console.log(
  `Simulated ${ROUNDS} rounds: catchRate=${catchRate.toFixed(2)}% (${caughtCount}/${ROUNDS}), unanimityRate=${unanimityRate.toFixed(2)}% (${unanimousCount}/${ROUNDS})`,
);

assert.ok(catchRate >= 35 && catchRate <= 65, `catchRate ${catchRate.toFixed(2)}% outside 35%..65%`);
assert.ok(unanimityRate < 40, `unanimityRate ${unanimityRate.toFixed(2)}% >= 40%`);

// Verify ALLIN=0 disables conviction votes (>= 8) while enabled allows them on clear lead > 5.
const clearTable: TableView = {
  price: 150_00000000,
  openPrice: 150_00000000,
  seats: Array.from({ length: SEATS }, () => ({ pos: 0, trades: 1, empty: false })),
  tape: [{ seat: 3, delta: 5, t: 10 }, { seat: 3, delta: 1, t: 12 }],
  shocks: [{ at: 15, bps: 200 }, { at: 0, bps: 0 }, { at: 0, bps: 0 }, { at: 0, bps: 0 }],
};
const stAllIn = initBotRound(0, "follower", () => 0.9); // voteAt ~ 71.8, rng=0.9 avoids 15% abstain
const vEnabled = decideVote(clearTable, stAllIn, 72, () => 0.9, true);
assert.strictEqual(vEnabled, 3 + CONVICTION);
const stNoAllIn = initBotRound(0, "follower", () => 0.9);
const vDisabled = decideVote(clearTable, stNoAllIn, 72, () => 0.9, false);
assert.strictEqual(vDisabled, 3);

console.log("ALL BOT SIMULATION CHECKS PASSED");
