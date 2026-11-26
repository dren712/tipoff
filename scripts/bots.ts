// Pure bot decision logic (no RPC, no wall clock, no global randomness).
import { CONVICTION, ROUND_SECS, SEATS } from "./lib.js";

export type TraderStyle = "follower" | "skeptic" | "momentum" | "holder" | "scalper";
export const TRADER_STYLES: readonly TraderStyle[] = ["follower", "skeptic", "momentum", "holder", "scalper"];

export type ShockView = { at: number; bps: number };
export type PrintView = { seat: number; delta: number; t: number };
export type SeatView = { pos: number; trades: number; empty: boolean };
export type TableView = {
  price: number;
  openPrice: number;
  seats: SeatView[];
  tape: PrintView[];
  shocks: ShockView[];
};

export type BotRoundState = {
  seat: number;
  style: TraderStyle;
  voteAt: number;
  voted: boolean;
  // Insider per-round plan state
  doDecoy: boolean;
  decoyAt: number;
  decoyDone: boolean;
  preLead: number[];
  actedPre: boolean[];
  playFalse: boolean[];
  // Non-insider reaction tracking
  rumourHandled: boolean[];
  rumourDelay: number[];
  rumourPlay: boolean[];
  shockHandled: boolean[];
  seenRumours: number[];
  holderOpened: boolean;
  holderDir: number;
  holderSize: number;
  lastMomentumAt: number;
  priceHist: { t: number; p: number }[];
};

export const isRumour = (s: ShockView): boolean => Math.abs(s.bps) === 1;
export const isRealShock = (s: ShockView): boolean => Math.abs(s.bps) > 1;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleStyles(rng: () => number, count = SEATS): TraderStyle[] {
  const pool: TraderStyle[] = [...TRADER_STYLES];
  while (pool.length < count) {
    pool.push(TRADER_STYLES[Math.floor(rng() * TRADER_STYLES.length)]);
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

export function initBotRound(seat: number, style: TraderStyle, rng: () => number): BotRoundState {
  const randInt = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  return {
    seat,
    style,
    voteAt: 61 + rng() * 12,
    voted: false,
    doDecoy: rng() < 0.5,
    decoyAt: 2 + rng() * 10,
    decoyDone: false,
    preLead: Array.from({ length: 4 }, () => 2 + rng() * 4),
    actedPre: [false, false, false, false],
    playFalse: Array.from({ length: 4 }, () => rng() < 0.6),
    rumourHandled: [false, false, false, false],
    rumourDelay: Array.from({ length: 4 }, () => 1 + rng() * 2),
    rumourPlay: Array.from({ length: 4 }, () =>
      style === "follower" ? rng() < 0.8 : style === "skeptic" ? rng() < 0.6 : false,
    ),
    shockHandled: [false, false, false, false],
    seenRumours: [0, 0, 0, 0],
    holderOpened: false,
    holderDir: rng() < 0.5 ? 1 : -1,
    holderSize: randInt(2, 4),
    lastMomentumAt: -10,
    priceHist: [],
  };
}

const num = (v: any): number => (typeof v === "number" ? v : v?.toNumber?.() ?? Number(v ?? 0));

/// Normalizes an Anchor `Table` account or plain simulation object into `TableView`.
export function toTableView(s: any, zeroKey: { equals(other: any): boolean }): TableView {
  const tapeCount = Math.min(s.tapeLen ?? s.tape.length, s.tape.length);
  const tape: PrintView[] = [];
  for (let i = 0; i < tapeCount; i++) {
    const p = s.tape[i];
    tape.push({ seat: p.seat, delta: p.delta, t: p.t });
  }
  return {
    price: num(s.price),
    openPrice: num(s.openPrice),
    seats: s.seats.map((x: any) => ({
      pos: x.pos,
      trades: x.trades,
      empty: x.player ? zeroKey.equals(x.player) : Boolean(x.empty),
    })),
    tape,
    shocks: s.shocks.map((sh: any) => ({ at: sh.at, bps: sh.bps })),
  };
}

export function observeTable(state: BotRoundState, table: TableView, elapsed: number): void {
  for (let i = 0; i < table.shocks.length; i++) {
    const sh = table.shocks[i];
    if (isRumour(sh)) state.seenRumours[i] = Math.sign(sh.bps);
  }
  state.priceHist.push({ t: elapsed, p: table.price });
  while (state.priceHist.length > 0 && elapsed - state.priceHist[0].t > 12) {
    state.priceHist.shift();
  }
}

function clampDelta(pos: number, delta: number, maxAbs: number): number {
  const d = Math.round(delta);
  return Math.max(-maxAbs - pos, Math.min(maxAbs - pos, d));
}

export function decideTrade(
  table: TableView,
  state: BotRoundState,
  insiderPlan: ShockView[] | null,
  elapsed: number,
  rng: () => number,
): number {
  if (elapsed < 0 || elapsed >= ROUND_SECS - 1) return 0;
  observeTable(state, table, elapsed);
  const seat = table.seats[state.seat];
  if (!seat || seat.empty) return 0;

  if (insiderPlan) {
    // Optional small wrong-way decoy in first 15 s on half of rounds.
    if (state.doDecoy && !state.decoyDone && elapsed <= 15 && elapsed >= state.decoyAt && insiderPlan[0]) {
      state.decoyDone = true;
      return clampDelta(seat.pos, -Math.sign(insiderPlan[0].bps), 4);
    }
    for (let i = 0; i < insiderPlan.length; i++) {
      const sh = insiderPlan[i];
      if (state.actedPre[i]) continue;
      if (elapsed >= sh.at - state.preLead[i] && elapsed < sh.at) {
        state.actedPre[i] = true;
        const pub = table.shocks[i];
        const isFalseRumour = pub && isRumour(pub) && Math.sign(pub.bps) !== Math.sign(sh.bps);
        if (isFalseRumour && !state.playFalse[i]) return 0;
        const lots = 1 + Math.floor(rng() * 3);
        return clampDelta(seat.pos, Math.sign(sh.bps) * lots, 4);
      }
    }
    return 0;
  }

  // Non-insider styles.
  if (state.style === "follower" || state.style === "skeptic") {
    for (let i = 0; i < table.shocks.length; i++) {
      const sh = table.shocks[i];
      if (state.rumourHandled[i] || !isRumour(sh)) continue;
      const rumourAt = sh.at - 5;
      if (elapsed >= rumourAt + state.rumourDelay[i] && elapsed < sh.at) {
        state.rumourHandled[i] = true;
        if (!state.rumourPlay[i]) return 0;
        const lots = 1 + Math.floor(rng() * 3);
        const dir = state.style === "follower" ? Math.sign(sh.bps) : -Math.sign(sh.bps);
        return clampDelta(seat.pos, dir * lots, 5);
      }
    }
    return 0;
  }

  if (state.style === "momentum") {
    if (elapsed - state.lastMomentumAt < 5) return 0;
    const ref = [...state.priceHist].reverse().find((x) => elapsed - x.t >= 4.5);
    if (!ref || ref.p <= 0) return 0;
    const ret = (table.price - ref.p) / ref.p;
    if (Math.abs(ret) > 0.003) {
      state.lastMomentumAt = elapsed;
      const lots = 1 + Math.floor(rng() * 2);
      return clampDelta(seat.pos, Math.sign(ret) * lots, 5);
    }
    return 0;
  }

  if (state.style === "holder") {
    if (!state.holderOpened && elapsed >= 2 && seat.trades === 0) {
      state.holderOpened = true;
      return clampDelta(seat.pos, state.holderDir * state.holderSize, 5);
    }
    for (let i = 0; i < table.shocks.length; i++) {
      const sh = table.shocks[i];
      if (!state.shockHandled[i] && isRealShock(sh) && elapsed >= sh.at) {
        state.shockHandled[i] = true;
        if (seat.pos !== 0) return clampDelta(seat.pos, -Math.sign(seat.pos), 5);
      }
    }
    return 0;
  }

  // Scalper: flattens within 4 s after each shock; takes an occasional small probe otherwise.
  for (let i = 0; i < table.shocks.length; i++) {
    const sh = table.shocks[i];
    if (!state.shockHandled[i] && isRealShock(sh) && elapsed >= sh.at && elapsed <= sh.at + 4) {
      state.shockHandled[i] = true;
      if (seat.pos !== 0) return clampDelta(seat.pos, -seat.pos, 5);
    }
  }
  if (seat.pos === 0 && elapsed > 4 && elapsed < ROUND_SECS - 4 && rng() < 0.08) {
    return clampDelta(seat.pos, rng() < 0.5 ? 1 : -1, 5);
  }
  return 0;
}

export function suspicionScores(
  table: TableView,
  seenRumours: number[],
  rng: () => number,
): number[] {
  const score = Array.from({ length: SEATS }, () => rng() * 1.5);
  for (const p of table.tape) {
    for (let i = 0; i < table.shocks.length; i++) {
      const sh = table.shocks[i];
      if (!isRealShock(sh)) continue;
      const lead = sh.at - p.t;
      if (lead > 0 && lead <= 9) {
        const lots = Math.abs(p.delta);
        if (Math.sign(p.delta) === Math.sign(sh.bps)) {
          const r = seenRumours[i] ?? 0;
          const againstRumour = r !== 0 && Math.sign(p.delta) !== Math.sign(r);
          score[p.seat] += lots * (againstRumour ? 2 : 1);
        } else {
          score[p.seat] -= lots * 0.5;
        }
      }
    }
  }
  return score;
}

export function decideVote(
  table: TableView,
  state: BotRoundState,
  elapsed: number,
  rng: () => number,
  allowAllIn = true,
): number | null {
  if (state.voted || elapsed < 61 || elapsed < state.voteAt || elapsed >= ROUND_SECS + 15) {
    return null;
  }
  state.voted = true;
  if (rng() < 0.15) return null;

  const scores = suspicionScores(table, state.seenRumours, rng);
  const ranked: { seat: number; score: number }[] = [];
  for (let i = 0; i < SEATS; i++) {
    if (i === state.seat || table.seats[i]?.empty) continue;
    ranked.push({ seat: i, score: scores[i] });
  }
  if (ranked.length === 0) return null;
  ranked.sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const second = ranked[1]?.score ?? 0;
  if (allowAllIn && top.score - second > 5) {
    return top.seat + CONVICTION;
  }
  return top.seat;
}
