import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as chainMod from "./chain";
import {
  CONVICTION, FIRST_TABLE, INTERMISSION, MAX_POS, NONE, ROUND_SECS, SEATS, Session, Table, SeatPrivate, VOTE_SECS, ZERO, actions, base, equity, explorer,
  isRumour, voteSeat,
  fetchSeat, fetchTable, ledgerPda, redraw, secretPda, seatPda, short, tablePda,
} from "./chain";
import { Chart } from "./Chart";
import type { Point, Mark } from "./Chart";
import { Evidence } from "./Evidence";
import { Icon, Logo } from "./Icon";
import { Avatar, SEAT_COLORS, SEAT_NAMES } from "./Avatar";
import { Career, CareerRound } from "./Career";
import { isMuted, setMuted, sfx } from "./sound";
import { Scene3D, Stage } from "./Scene3D";
import "./css/onboarding.css";
import "./css/deck.css";
import "./css/hud.css";
import "./css/juice.css";

const chips = (n: number) => {
  const v = Math.round(n);
  return v === 0 ? "0" : `${v > 0 ? "+" : "−"}${Math.abs(v)}`;
};
const pct = (bps: number) => `${bps > 0 ? "+" : "−"}${(Math.abs(bps) / 100).toFixed(1)}%`;
const usd = (p: number) => (p / 1e8).toFixed(2);
type Line = { ok: boolean; text: string; href?: string };
type Pop = { id: number; delta: number };
type Hist = { round: string; points: Point[]; marks: Mark[]; seen: number; shocks: number; phase: number; rumours: Record<number, number> };
type SnapSeat = {
  seat: number;
  name: string;
  played: boolean;
  cashRaw: number;
  lastRaw: number;
  cash: number;
  last: number;
  vote: number;
  suspect: number;
  allIn: boolean;
  votesGot: number;
};
type RevealSnap = {
  round: string;
  tableId: number;
  insider: number;
  caught: boolean;
  mySeat: number;
  accusers: number;
  seats: SnapSeat[];
};
type BreakdownItem = { text: string; tone?: "up" | "down" };

const snapKey = (index: number) => `tipoff-snap-${FIRST_TABLE + index}`;

function buildSnap(t: Table, round: string, tableId: number, me: Session["kp"]["publicKey"]): RevealSnap {
  const conv = Number((chainMod as { CONVICTION?: number }).CONVICTION ?? 8);
  const mySeat = t.seats.findIndex((s) => s.player.equals(me));
  const seats = t.seats.map((s, i) => {
    const played = true;
    const cashRaw = s.cash.toNumber();
    const lastRaw = s.last.toNumber();
    const vote = t.votes[i] ?? NONE;
    const suspect = voteSeat(vote);
    const allIn = vote >= conv && vote < conv + SEATS;
    return {
      seat: i,
      name: SEAT_NAMES[i],
      played,
      cashRaw,
      lastRaw,
      cash: cashRaw / 1e6,
      last: lastRaw / 1e6,
      vote,
      suspect,
      allIn,
      votesGot: 0,
    };
  });
  const accusers = seats.filter((o) => o.played && o.seat !== t.insider && o.suspect === t.insider).length;
  for (const target of seats) {
    target.votesGot = seats.filter((o) => o.played && o.seat !== t.insider && o.suspect === target.seat).length;
  }
  return { round, tableId, insider: t.insider, caught: t.caught, mySeat, accusers, seats };
}

function verdictLine(s: RevealSnap): string {
  const ins = s.seats[s.insider];
  const acc = s.accusers;
  if (s.caught) return `Caught by ${acc} accuser${acc === 1 ? "" : "s"}. Fined 100, profit shared out.`;
  const head = ins && ins.cashRaw > 0 ? "Got away with it. Profit doubled." : "Got away, but blew the tip.";
  const tail = acc === 0 ? "Nobody suspected them." : `${acc} accused them, not enough to convict.`;
  return `${head} ${tail}`;
}

function breakdownOf(s: RevealSnap): BreakdownItem[] {
  if (s.mySeat < 0) return [];
  const mine = s.seats[s.mySeat];
  if (!mine || !mine.played) return [];
  const trading = Math.round(mine.cash);
  const total = Math.round(mine.last);
  const tTone = trading > 0 ? "up" : trading < 0 ? "down" : undefined;
  const out: BreakdownItem[] = [{ text: `Trading ${chips(trading)}`, tone: tTone }];
  if (mine.seat === s.insider) {
    const delta = total - trading;
    if (!s.caught) {
      out.push({
        text: mine.cashRaw > 0 ? `Profit doubled ${chips(delta)}` : `Blew the tip ${chips(delta)}`,
        tone: delta > 0 ? "up" : delta < 0 ? "down" : undefined,
      });
    } else {
      if (trading > 0) out.push({ text: `Profit forfeited ${chips(-trading)}`, tone: "down" });
      const fine = total - (trading > 0 ? 0 : trading);
      if (fine !== 0) out.push({ text: `Fined ${chips(fine)}`, tone: "down" });
    }
    return out;
  }
  if (mine.suspect === NONE) {
    out.push({ text: "Accusation: No vote" });
    return out;
  }
  const right = mine.suspect === s.insider;
  const accVal = right ? (mine.allIn ? 200 : 100) : (mine.allIn ? -150 : -50);
  const accName = mine.allIn ? (right ? "All in right" : "All in wrong") : (right ? "Right" : "Wrong");
  out.push({ text: `Accusation: ${accName} ${chips(accVal)}`, tone: right ? "up" : "down" });
  const share = total - trading - accVal;
  if (right && s.caught && share > 0) out.push({ text: `Profit split ${chips(share)}`, tone: "up" });
  return out;
}

export function TableView({ session, index, autoSit = false, median, onLeave, onLatency }: { session: Session; index: number; autoSit?: boolean; median: number | null; onLeave: () => void; onLatency: (ms: number) => void }) {
  const key = useMemo(() => tablePda(FIRST_TABLE + index), [index]);
  const [t, setT] = useState<Table | null>(null);
  const [now, setNow] = useState(Date.now() / 1000);
  const [priv, setPriv] = useState<SeatPrivate | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [proof, setProof] = useState<Line[]>([]);
  const [side, setSide] = useState<"tape" | "proof" | null>(null);
  const [moves, setMoves] = useState(0);
  const [pulseProof, setPulseProof] = useState(() => {
    try { return !localStorage.getItem("tipoff-proof-seen"); } catch { return true; }
  });
  const markProofSeen = useCallback(() => {
    setPulseProof(false);
    try { localStorage.setItem("tipoff-proof-seen", "1"); } catch {}
  }, []);
  const toggleProof = useCallback(() => {
    setSide((s) => (s === "proof" ? null : "proof"));
    markProofSeen();
  }, [markProofSeen]);
  const [pops, setPops] = useState<Record<number, Pop>>({});
  const [flash, setFlash] = useState<{ id: number; bps: number; rumourTrue?: boolean } | null>(null);
  const [priceTick, setPriceTick] = useState<"" | "up" | "down">("");
  const [pressedBtn, setPressedBtn] = useState<"" | "buy" | "sell">("");
  const [intent, setIntent] = useState<{ inFlight: number; queued: number }>({ inFlight: 0, queued: 0 });
  const [roleCard, setRoleCard] = useState<{ round: string; insider: boolean } | null>(null);
  const [stage, setStage] = useState(2); // reveal: 0 drum roll, 1 unmask, 2 scores
  const [scoreMul, setScoreMul] = useState(1);
  const [voted, setVoted] = useState<{ round: string; suspect: number } | null>(null);
  const [allIn, setAllIn] = useState(false);
  const [wantSit, setWantSit] = useState(autoSit);
  const [witnessedRound, setWitnessedRound] = useState("");
  const [snap, setSnap] = useState<RevealSnap | null>(null);
  const snapRef = useRef<RevealSnap | null>(null);
  const [coachRound, setCoachRound] = useState("");
  const [muted, setMute] = useState(isMuted());
  const hist = useRef<Hist>({ round: "", points: [], marks: [], seen: 0, shocks: 0, phase: -1, rumours: {} });
  const rumourSeen = useRef<Map<number, number>>(new Map());
  const prevPrice = useRef(0);
  const settledPos = useRef({ round: "", pos: 0, trades: 0 });
  const tradeRef = useRef({ inFlight: 0, flightTrades: 0, queued: 0, busy: false });
  const liveRef = useRef({ seatIdx: -1, round: "", tStart: 0, phase: 0 });
  const pendingFlight = () =>
    settledPos.current.round === liveRef.current.round && settledPos.current.trades > tradeRef.current.flightTrades
      ? 0
      : tradeRef.current.inFlight;
  const shownRole = useRef("");
  const voteLock = useRef("");
  const sitAttempt = useRef({ count: 0, triedSeat: -1 });
  const autoSitting = useRef(false);
  const me = session.id;
  const mySeatRef = useRef(-1);
  const hostRef = useRef<HTMLDivElement>(null);
  const tagRefs = useRef<(HTMLElement | null)[]>([]);
  const scene = useRef<Scene3D | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const celebratedRef = useRef("");
  const pick = useRef<(i: number) => void>(() => {});
  const loaded = !!t;
  useEffect(() => {
    if (!loaded || !hostRef.current) return;
    const s = (scene.current = new Scene3D(hostRef.current, SEAT_COLORS, () => tagRefs.current, (i) => pick.current(i)));
    return () => { s.dispose(); scene.current = null; };
  }, [loaded]);

  useEffect(() => {
    let live = true;
    snapRef.current = null;
    setSnap(null);
    const load = async () => {
      const next = await fetchTable(session, key).catch(() => null);
      if (!live || !next) return;
      const round = next.round.toString();
      if (hist.current.round !== round) {
        hist.current = { round, points: [], marks: [], seen: next.phase === 2 ? Math.max(0, next.tapeLen - next.tape.length) : next.tapeLen, shocks: next.phase === 2 ? next.shocksSeen : 0, phase: hist.current.phase, rumours: {} };
        rumourSeen.current.clear();
        tradeRef.current = { inFlight: 0, flightTrades: 0, queued: 0, busy: false };
        setIntent({ inFlight: 0, queued: 0 });
      }
      const nsIdx = next.seats.findIndex((s) => s.player.equals(me));
      if (nsIdx >= 0) {
        const ns = next.seats[nsIdx];
        if (settledPos.current.round !== round || ns.trades >= settledPos.current.trades) {
          settledPos.current = { round, pos: ns.pos, trades: ns.trades };
        }
      }
      const h = hist.current;
      const first = h.phase === -1;
      if (next.phase === 2) {
        next.shocks.forEach((s, i) => {
          if (isRumour(s)) {
            const wasNew = !rumourSeen.current.has(i);
            const dir = Math.sign(s.bps);
            rumourSeen.current.set(i, dir);
            h.rumours[i] = dir;
            if (wasNew && !first) { sfx.rumour(); scene.current?.news(s.bps, { rumour: true }); }
          }
        });
        const el = Math.min(ROUND_SECS, Date.now() / 1000 - next.tStart.toNumber());
        if (el >= 0) h.points.push({ t: el, p: next.price.toNumber() });
        const fresh: Record<number, Pop> = {};
        for (let k = h.seen; k < next.tapeLen; k++) {
          const p = next.tape[k % next.tape.length];
          h.marks.push({ t: p.t, p: p.price.toNumber(), seat: p.seat, delta: p.delta });
          fresh[p.seat] = { id: k, delta: p.delta };
          if (!first && p.seat !== mySeatRef.current) scene.current?.trade(p.seat, p.delta);
          if (!first && p.seat !== mySeatRef.current) sfx.tick(p.delta > 0);
        }
        if (Object.keys(fresh).length && !first) setPops((o) => ({ ...o, ...fresh }));
        h.seen = next.tapeLen;
        if (next.shocksSeen > h.shocks) {
          const idx = next.shocksSeen - 1;
          const sh = next.shocks[idx];
          if (!isRumour(sh) && Math.abs(sh.bps) > 1) {
            const bps = sh.bps;
            const rDir = rumourSeen.current.get(idx);
            const rumourTrue = rDir !== undefined ? rDir === Math.sign(bps) : undefined;
            if (!first) {
              setFlash({ id: Date.now(), bps, rumourTrue });
              idx === 3 ? sfx.shockBig(bps > 0) : sfx.news(bps > 0);
              scene.current?.news(bps, { fourth: idx === 3 });
            }
            h.shocks = next.shocksSeen;
          }
        }
        if (h.phase === 1) sfx.bell();
      }
      if (next.phase !== 3) {
        if (snapRef.current) {
          snapRef.current = null;
          setSnap(null);
          try { sessionStorage.removeItem(snapKey(index)); } catch {}
        }
      } else if (first) {
        try {
          const raw = sessionStorage.getItem(snapKey(index));
          if (raw) {
            const saved = JSON.parse(raw) as RevealSnap;
            if (saved.round === round && saved.seats?.length === SEATS && saved.seats.every((x) => x.played)) {
              snapRef.current = saved;
              setSnap(saved);
              setWitnessedRound(round);
              setStage(2);
            }
          }
        } catch {}
      }
      if (next.phase === 3 && h.phase === 2) {
        const s = buildSnap(next, round, FIRST_TABLE + index, me);
        snapRef.current = s;
        setSnap(s);
        try { sessionStorage.setItem(snapKey(index), JSON.stringify(s)); } catch {}
        setWitnessedRound(round);
        setStage(0);
        sfx.drum();
        setTimeout(() => { setStage(1); next.caught ? sfx.caught() : sfx.escaped(); }, 1600);
        setTimeout(() => { setStage(2); sfx.payout(); }, 4200);
      }
      h.phase = next.phase;
      setT(next);
      setNow(Date.now() / 1000);
    };
    load();
    const id = setInterval(load, 350);
    return () => { live = false; clearInterval(id); };
  }, [session, key]);

  const mySeat = t ? t.seats.findIndex((s) => s.player.equals(me)) : -1;
  mySeatRef.current = mySeat;
  const round = t?.round.toString() ?? "";
  const phase = t?.phase ?? 0;

  // The seat's private account: only this browser's key can read it.
  useEffect(() => {
    if (mySeat < 0) { setPriv(null); return; }
    let live = true;
    const load = () => fetchSeat(session, key, mySeat).then((p) => live && setPriv(p)).catch(() => {});
    load();
    const id = setInterval(load, 1000);
    return () => { live = false; clearInterval(id); };
  }, [session, key, mySeat, round, phase]);

  const run = useCallback(async (label: string, fn: () => Promise<{ sig: string; ms: number }>, onFail?: () => void) => {
    setBusy(true);
    try {
      const r = await fn();
      setToast(`${label} · ${r.ms} ms`);
    } catch (e: any) {
      onFail?.();
      setToast(`${label} failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(""), 3000); return () => clearTimeout(id); }, [toast]);
  useEffect(() => { if (!flash) return; const id = setTimeout(() => setFlash(null), 2200); return () => clearTimeout(id); }, [flash]);

  const elapsed = t && phase === 2 ? now - t.tStart.toNumber() : 0;
  const trading = phase === 2 && elapsed < ROUND_SECS;
  const accusing = phase === 2 && elapsed >= ROUND_SECS;
  const canVote = phase === 2 && elapsed < ROUND_SECS + VOTE_SECS;
  const seat = t && mySeat >= 0 ? t.seats[mySeat] : null;
  const current = priv && t && priv.round.eq(t.round) ? priv : null;
  const insider = current?.role === 2 && phase === 2;
  const chainVote = current && current.vote !== NONE ? voteSeat(current.vote) : null;
  const myVote = chainVote !== null ? chainVote : voted && voted.round === round ? voted.suspect : null;
  const locked = myVote !== null;
  const price = t?.price.toNumber() ?? 0;
  const openPrice = t?.openPrice.toNumber() ?? 0;

  useEffect(() => {
    voteLock.current = "";
    setVoted(null);
    setAllIn(false);
  }, [round]);

  const accuse = async (i: number) => {
    if (mySeat < 0 || !canVote || busy || myVote !== null || voteLock.current === round || i === mySeat || t?.seats[i]?.player.equals(ZERO)) return;
    voteLock.current = round;
    setVoted({ round, suspect: i });
    sfx.gavel(allIn);
    setBusy(true);
    try {
      const arg = allIn ? i + CONVICTION : i;
      const r = await actions.vote(session, key, mySeat, arg);
      onLatency(r.ms);
      setMoves((m) => m + 1);
      setToast(`${allIn ? "All-in accused" : "Accused"} ${SEAT_NAMES[i]} · ${r.ms} ms`);
    } catch (e: any) {
      const errorText = String(e?.message ?? e);
      if (errorText.includes("AlreadyVoted") || errorText.includes("6011")) {
        setToast("Vote already recorded");
      } else {
        voteLock.current = "";
        setVoted((v) => (v?.round === round ? null : v));
        setToast(`Accused ${SEAT_NAMES[i]} failed: ${errorText}`);
      }
    } finally {
      setBusy(false);
    }
  };

  // Deal the role card once per round.
  useEffect(() => {
    if (!current || phase !== 2 || elapsed > 12 || shownRole.current === round) return;
    shownRole.current = round;
    setRoleCard({ round, insider: current.role === 2 });
    sfx.role(current.role === 2);
  }, [current, phase, round, elapsed]);
  useEffect(() => { if (!roleCard) return; const id = setTimeout(() => setRoleCard(null), 2500); return () => clearTimeout(id); }, [roleCard]);

  // Auto-sit when launched from Lobby "Play now": retries next open seat once on failure, then falls back to manual.
  useEffect(() => {
    if (!wantSit || !t || mySeat >= 0) {
      if (mySeat >= 0 && wantSit) setWantSit(false);
      return;
    }
    if (busy || autoSitting.current || (phase !== 0 && phase !== 3)) return;
    const target = t.seats.findIndex((s, i) => s.player.equals(ZERO) && i !== sitAttempt.current.triedSeat);
    if (target < 0) return;
    autoSitting.current = true;
    run(
      "Seated",
      async () => {
        try {
          return await actions.sit(session, key, target);
        } catch (e: any) {
          if (!/seat is taken|SeatTaken|\b6003\b|0x1773/i.test(String(e?.message ?? e))) throw e;
          sitAttempt.current = { count: 1, triedSeat: target };
          const fresh = await fetchTable(session, key).catch(() => null);
          const next = fresh?.seats.findIndex((s, i) => i !== target && s.player.equals(ZERO)) ?? -1;
          if (next < 0) throw e;
          return actions.sit(session, key, next);
        }
      },
      () => {
        if (session.player) {
          setWantSit(false);
        } else if (sitAttempt.current.count === 0) {
          sitAttempt.current = { count: 1, triedSeat: target };
        } else {
          setWantSit(false);
        }
      },
    ).finally(() => {
      autoSitting.current = false;
    });
  }, [wantSit, t, mySeat, phase, busy, session, key, run]);

  // First-round-only coach line for the first 10 s of trading.
  useEffect(() => {
    if (!seat || phase !== 2 || !trading || elapsed >= 10 || coachRound === round) return;
    try {
      if (localStorage.getItem("tipoff-coached")) return;
      localStorage.setItem("tipoff-coached", "1");
      setCoachRound(round);
    } catch {}
  }, [seat, phase, trading, elapsed, round, coachRound]);

  liveRef.current = { seatIdx: mySeat, round, tStart: t?.tStart.toNumber() ?? 0, phase };

  useEffect(() => {
    if (!price) { prevPrice.current = 0; setPriceTick(""); return; }
    if (prevPrice.current > 0 && price !== prevPrice.current) {
      setPriceTick(price > prevPrice.current ? "up" : "down");
      const id = setTimeout(() => setPriceTick(""), 700);
      prevPrice.current = price;
      return () => clearTimeout(id);
    }
    prevPrice.current = price;
  }, [price]);

  const flushTrade = useCallback(async () => {
    const tr = tradeRef.current;
    if (tr.busy) return;
    const lv = liveRef.current;
    const liveNow = lv.phase === 2 && Date.now() / 1000 - lv.tStart < ROUND_SECS;
    if (!liveNow || lv.seatIdx < 0) {
      tr.inFlight = 0;
      tr.flightTrades = 0;
      tr.queued = 0;
      setIntent({ inFlight: 0, queued: 0 });
      return;
    }
    const basePos = settledPos.current.round === lv.round ? settledPos.current.pos : 0;
    const tradesBefore = settledPos.current.round === lv.round ? settledPos.current.trades : 0;
    const clamped = Math.max(-MAX_POS - basePos, Math.min(MAX_POS - basePos, Math.trunc(tr.queued)));
    tr.queued = 0;
    if (clamped === 0) {
      tr.inFlight = 0;
      tr.flightTrades = 0;
      setIntent({ inFlight: 0, queued: 0 });
      return;
    }
    tr.busy = true;
    tr.inFlight = clamped;
    tr.flightTrades = tradesBefore;
    setIntent({ inFlight: clamped, queued: 0 });
    try {
      const r = await actions.trade(session, key, lv.seatIdx, clamped);
      onLatency(r.ms);
      setMoves((m) => m + 1);
      setToast(`${clamped > 0 ? `Bought ${clamped}` : `Sold ${-clamped}`} · ${r.ms} ms`);
      if (settledPos.current.round === lv.round && settledPos.current.trades === tradesBefore) {
        settledPos.current.pos += clamped;
        settledPos.current.trades += 1;
      }
      tr.inFlight = 0;
      tr.flightTrades = 0;
    } catch (e: any) {
      tr.inFlight = 0;
      tr.flightTrades = 0;
      tr.queued = 0;
      setIntent({ inFlight: 0, queued: 0 });
      setToast(`Trade failed: ${e?.message ?? e}`);
      tr.busy = false;
      return;
    }
    tr.busy = false;
    if (tradeRef.current.queued !== 0) {
      void flushTrade();
    } else {
      setIntent({ inFlight: 0, queued: 0 });
    }
  }, [session, key, onLatency]);

  const trade = (d: number) => {
    const lv = liveRef.current;
    const liveNow = lv.phase === 2 && Date.now() / 1000 - lv.tStart < ROUND_SECS;
    if (!seat || !liveNow || lv.seatIdx < 0) return;
    const tr = tradeRef.current;
    const basePos = settledPos.current.round === lv.round ? settledPos.current.pos : seat.pos;
    const curIntent = basePos + pendingFlight() + tr.queued;
    const nextIntent = Math.max(-MAX_POS, Math.min(MAX_POS, curIntent + d));
    const add = nextIntent - curIntent;
    if (add === 0) return;
    sfx.mine(add > 0);
    scene.current?.trade(lv.seatIdx, add);
    tr.queued += add;
    setIntent({ inFlight: tr.inFlight, queued: tr.queued });
    if (!tr.busy) void flushTrade();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!seat || !trading) return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPressedBtn("buy");
        setTimeout(() => setPressedBtn((p) => (p === "buy" ? "" : p)), 90);
        trade(1);
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPressedBtn("sell");
        setTimeout(() => setPressedBtn((p) => (p === "sell" ? "" : p)), 90);
        trade(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Push the round into the 3D floor.
  useEffect(() => {
    if (!t || !scene.current) return;
    const seatedNow = t.seats.some((s) => !s.player.equals(ZERO)), hasSnap = snapRef.current?.round === round;
    const done = phase === 3 && (seatedNow || hasSnap) && witnessedRound === round;
    const st: Stage = phase === 1 ? "deal" : trading ? "live" : accusing ? "vote" : done ? (stage === 0 ? "drum" : "reveal") : "idle";
    const myAllIn = current && current.vote !== NONE ? current.vote >= CONVICTION : allIn;
    const sCur = snapRef.current;
    const scores = done && stage === 2
      ? (sCur && sCur.round === round ? sCur.seats.map((s) => s.last) : t.seats.map((s) => s.last.toNumber() / 1e6))
      : undefined;
    scene.current.set({
      stage: st, me: mySeat, insiderMe: !!insider, insider: t.insider, caught: t.caught, canVote: accusing && mySeat >= 0 && canVote && !busy && !locked,
      accused: myVote ?? undefined, allIn: myVote !== null ? myAllIn : undefined, scores,
      seats: t.seats.map((s) => ({ empty: s.player.equals(ZERO), pos: s.pos, mood: phase === 2 ? Math.sign(Math.round(equity(s, price, openPrice))) : 0 })),
      wall: {
        price, open: phase >= 2 ? openPrice : 0, elapsed, round: Number(round), points: hist.current.points, marks: hist.current.marks,
        shocks: t.shocks.filter((s) => Math.abs(s.bps) > 1 && phase >= 2), future: insider ? current!.shocks.filter((s) => s.at > elapsed) : [],
        title: st === "idle" ? "TAKE A SEAT" : st === "deal" ? "DEALING SECRET ROLES" : "",
        sub: st === "idle" ? "Bots fill the empty desks. One of the six will be the insider." : st === "deal" ? "MagicBlock VRF is picking the insider inside the private rollup" : "",
      },
    });
  });
  pick.current = accuse;

  const showScores = phase === 3 && stage === 2 && witnessedRound === round && (!!t?.seats.some((s) => !s.player.equals(ZERO)) || snap?.round === round);
  useEffect(() => {
    if (!showScores) { setScoreMul(1); return; }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { setScoreMul(1); return; }
    setScoreMul(0);
    const start = performance.now();
    let raf = 0;
    const tick = (nowMs: number) => {
      const p = Math.min(1, (nowMs - start) / 800);
      setScoreMul(1 - Math.pow(1 - p, 3));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [showScores, round]);

  useEffect(() => {
    if (!showScores || !resultsRef.current) return;
    const root = resultsRef.current;
    const check = () => {
      const careerEl = root.querySelector(".career");
      if (!careerEl) return;
      const rankText = careerEl.querySelector(".career-rank")?.textContent?.trim() ?? "";
      const hasNewBest = [...careerEl.querySelectorAll(".career-delta.gold")].some((d) => d.textContent?.includes("New best"));
      let prevRank = "";
      try { prevRank = localStorage.getItem("tipoff-last-rank") ?? ""; } catch {}
      const sNow = snapRef.current?.round === round ? snapRef.current : null;
      const myWon = !!(sNow && sNow.mySeat >= 0 && ((sNow.caught && sNow.seats[sNow.mySeat]?.suspect === sNow.insider) || (!sNow.caught && sNow.insider === sNow.mySeat)));
      const newRank = !!rankText && (prevRank ? rankText !== prevRank : (rankText !== "Rookie" && myWon));
      if (rankText) { try { localStorage.setItem("tipoff-last-rank", rankText); } catch {} }
      if ((hasNewBest || newRank) && celebratedRef.current !== round) {
        celebratedRef.current = round;
        careerEl.classList.add("career-burst");
        sfx.boardWin();
      }
    };
    check();
    const obs = new MutationObserver(check);
    obs.observe(root, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [showScores, round]);

  if (!t) return (
    <div className="boot">
      <div className="bootcard"><Logo size={56} /><h1 className="wordmark">Table {index + 1}</h1><div className="loader"><i /></div><p className="muted">Walking onto the floor</p></div>
    </div>
  );

  const seated = t.seats.some((s) => !s.player.equals(ZERO));
  const curSnap = snap && snap.round === round ? snap : null;
  const witnessed = witnessedRound === round;
  const settled = phase === 3 && (seated || !!curSnap) && witnessed;
  const canSit = mySeat < 0 && (phase === 0 || phase === 3);
  const openIn = phase === 2 ? Math.max(1, Math.ceil(t.tStart.toNumber() + ROUND_SECS + VOTE_SECS - now)) : 0;
  const waitState = phase === 1 ? "Dealing secret roles" : mySeat >= 0 ? "Bots are joining" : wantSit && phase === 2 ? `Seat opens in ${openIn}s` : "Finding you a seat";
  const nextIn = settled ? Math.max(0, Math.ceil(t.settledAt.toNumber() + INTERMISSION - now)) : 0;
  const future = insider ? current!.shocks.filter((s) => s.at > elapsed) : [];
  const nextShock = future[0];
  const votesFor = (i: number) => (settled && stage >= 1 ? (curSnap ? curSnap.seats[i]?.votesGot ?? 0 : t.votes.filter((v, k) => voteSeat(v) === i && k !== t.insider).length) : 0);

  const add = (l: Line) => setProof((p) => [l, ...p].slice(0, 12));
  const cheat = {
    secret: async () => {
      const info = await session.conn.getAccountInfo(secretPda(key)).catch(() => null);
      add(info ? { ok: false, text: "The sealed secret was readable. That should never happen." }
        : { ok: true, text: "Read the sealed secret (insider and shocks): the rollup returned nothing. Nobody is on its access list." });
    },
    seat: async () => {
      const other = (Math.max(mySeat, 0) + 1) % SEATS;
      const info = await session.conn.getAccountInfo(seatPda(key, other)).catch(() => null);
      add(info ? { ok: false, text: `${SEAT_NAMES[other]}'s private seat was readable.` }
        : { ok: true, text: `Read ${SEAT_NAMES[other]}'s role and vote: the rollup returned nothing. Only that seat's key may read it.` });
    },
    solana: async () => {
      const info = await base.getAccountInfo(secretPda(key));
      add({ ok: true, text: `Read the secret from Solana instead: it is owned by ${short(info!.owner)} (the delegation program) and frozen at its pre-game state. The live data exists only inside the TEE.`, href: explorer("address", secretPda(key).toBase58()) });
    },
    impersonate: async () => {
      const other = (Math.max(mySeat, 0) + 1) % SEATS;
      try {
        await actions.trade(session, key, other, 1);
        add({ ok: false, text: `Traded as ${SEAT_NAMES[other]}. That should never happen.` });
      } catch (e: any) {
        add({ ok: true, text: `Trade from ${SEAT_NAMES[other]}'s seat with your key: rejected by the program (${e?.message ?? e}).` });
      }
    },
    verify: async () => {
      const d = await redraw(t.revealedSalt);
      const same = d.insider === t.insider && d.shocks.every((s, i) => s.at === t.shocks[i].at && s.bps === t.shocks[i].bps);
      add({ ok: same, text: same
        ? `Recomputed round ${round} in your browser from the revealed salt: insider ${SEAT_NAMES[d.insider]}, shocks ${d.shocks.map((s) => `${pct(s.bps)} at ${s.at}s`).join(", ")}. It matches what the program settled.`
        : "The recomputed draw does not match the settled round." });
    },
    ledger: async () => {
      const sigs = await base.getSignaturesForAddress(ledgerPda(), { limit: 1 });
      add({ ok: true, text: "Latest round recorded on Solana by a Magic Action after the rollup committed the table.", href: sigs[0] ? explorer("tx", sigs[0].signature) : explorer("address", ledgerPda().toBase58()) });
    },
  };

  // Presentation only below: which screen is showing and the numbers it prints.
  const ui: Stage = phase === 1 ? "deal" : trading ? "live" : accusing ? "vote" : settled ? (stage === 0 ? "drum" : "reveal") : "idle";
  const showHowTo = (ui === "idle" || ui === "deal") && (mySeat >= 0 || wantSit);
  const showCoach = ui === "live" && !!seat && trading && coachRound === round && elapsed < 10;
  const eq = t.seats.map((s) => (phase === 2 ? equity(s, price, openPrice) : 0));
  const myEq = mySeat >= 0 ? eq[mySeat] : 0;
  const change = openPrice && phase >= 2 ? ((price - openPrice) / openPrice) * 100 : 0;
  const left = trading ? ROUND_SECS - elapsed : accusing && canVote ? ROUND_SECS + VOTE_SECS - elapsed : 0;
  const frac = trading ? left / ROUND_SECS : accusing && canVote ? left / VOTE_SECS : 0;
  const firstOpen = t.seats.findIndex((s) => s.player.equals(ZERO));
  const ranked = curSnap
    ? curSnap.seats.filter((s) => s.played).sort((a, b) => b.last - a.last)
    : [];
  const feed = hist.current.marks.slice(-5).reverse();
  const mySnap = curSnap && curSnap.mySeat >= 0 ? curSnap.seats[curSnap.mySeat] : null;
  const myLast = mySnap ? mySnap.last : seat ? seat.last.toNumber() / 1e6 : 0;
  const breakdown = curSnap ? breakdownOf(curSnap) : [];
  const careerRound: CareerRound | null = curSnap ? {
    tableId: curSnap.tableId,
    round: curSnap.round,
    played: curSnap.mySeat >= 0,
    lastRaw: mySnap?.lastRaw ?? 0,
    caughtRight: !!mySnap && mySnap.seat !== curSnap.insider && mySnap.suspect === curSnap.insider,
    wrongVote: !!mySnap && mySnap.seat !== curSnap.insider && mySnap.suspect !== NONE && mySnap.suspect !== curSnap.insider,
    escapedInsider: !!mySnap && mySnap.seat === curSnap.insider && !curSnap.caught,
  } : null;
  const R = 25, C = 2 * Math.PI * R;
  const leverage = Number((chainMod as { LEVERAGE?: number }).LEVERAGE ?? 0);
  const confirmedPos = seat ? (settledPos.current.round === round ? settledPos.current.pos : seat.pos) : 0;
  const intentPos = Math.max(-MAX_POS, Math.min(MAX_POS, confirmedPos + pendingFlight() + intent.queued));
  const activeRumourIdx = trading ? t.shocks.findIndex((s) => isRumour(s) && s.at > elapsed) : -1;
  const activeRumour = activeRumourIdx >= 0 ? t.shocks[activeRumourIdx] : null;
  const rumourTruth = activeRumour && insider && current?.shocks[activeRumourIdx]
    ? Math.sign(activeRumour.bps) === Math.sign(current.shocks[activeRumourIdx].bps)
    : null;
  const closingBell = trading && elapsed >= 48 && t.shocksSeen < 4;
  const priceBox = price > 0 && (
    <div className="quote">
      <span className="quote-sym">{leverage > 0 ? `LIVE SOL x${leverage}` : "SOL"}</span>
      <b className={`num price-val ${priceTick}`}>${usd(price)}</b>
      {phase >= 2 && openPrice > 0 && <span className={`delta ${change >= 0 ? "up" : "down"}`}><Icon name={change >= 0 ? "up" : "down"} size={11} />{Math.abs(change).toFixed(2)}%</span>}
    </div>
  );

  return (
    <main className={`game ui-${ui} ${insider ? "asinsider" : ""} ${mySeat >= 0 ? "seated" : "watching"} ${side ? "drawer-open" : ""}`}>
      <div className={`stage ${flash ? (flash.bps > 0 ? "flashup" : "flashdown") : ""}`}>
        <div className="canvas" ref={hostRef} />
        <div className="scrim" />
        {t.seats.map((s, i) => {
          const empty = s.player.equals(ZERO), pop = pops[i], last = s.last.toNumber() / 1e6;
          return (
            <div key={i} className={`tag ${i === mySeat ? "me" : ""} ${empty ? "empty" : ""}`} ref={(el) => (tagRefs.current[i] = el)} style={{ ["--c" as any]: SEAT_COLORS[i] }}>
              {pop && trading && <span key={pop.id} className={`pop ${pop.delta > 0 ? "up" : "down"}`}><Icon name={pop.delta > 0 ? "up" : "down"} size={12} />{pop.delta > 0 ? "BUY" : "SELL"} {Math.abs(pop.delta)}</span>}
              {votesFor(i) > 0 && <span className="votes"><Icon name="gavel" size={12} />{votesFor(i)}</span>}
              {empty ? (canSit ? <button className="sit" disabled={busy} onClick={() => run("Seated", () => actions.sit(session, key, i))}>Sit here</button> : <span className="plate ghost">Open</span>) : (
                <>
                  <span className="plate"><b>{SEAT_NAMES[i]}</b>{i === mySeat && <em>You</em>}</span>
                  {trading && <span className={`tag-pnl num ${eq[i] >= 0 ? "up" : "down"}`}>{chips(eq[i])}</span>}
                  {accusing && myVote === i && <span className="tag-mark"><Icon name="gavel" size={12} />Accused</span>}
                  {settled && stage === 2 && <span className={`tag-pnl num big ${last >= 0 ? "up" : "down"}`}>{chips(last)}</span>}
                </>
              )}
            </div>
          );
        })}

        {mySeat >= 0 && phase === 2 && current && !roleCard && (
          <div className={`rolechip ${insider ? "ins" : ""}`}><Icon name={insider ? "eye" : "bolt"} size={15} /><span>You are {insider ? "the insider" : "a trader"}</span></div>
        )}
        {(insider && trading && nextShock || activeRumour || closingBell) && (
          <div className="stage-banners">
            {insider && trading && nextShock && (
              <div className="tip" role="status">
                <span className="tip-tag"><Icon name="eye" size={13} />Tip-off</span>
                <span className="tip-main">News in <b className="num">{Math.max(0, Math.ceil(nextShock.at - elapsed))}s</b></span>
                <b className={`tip-move num ${nextShock.bps > 0 ? "up" : "down"}`}><Icon name={nextShock.bps > 0 ? "up" : "down"} size={13} />{pct(nextShock.bps)}</b>
                {rumourTruth !== null && <span className={`tip-verdict ${rumourTruth ? "truth" : "lie"}`}>{rumourTruth ? "The rumour is TRUE" : "The rumour is a LIE"}</span>}
                {future.length > 1 && <span className="tip-next">then {future.slice(1).map((f) => `${pct(f.bps)} at ${f.at}s`).join(", ")}</span>}
              </div>
            )}
            {activeRumour && (
              <div className={`rumour ${activeRumour.bps > 0 ? "up" : "down"}`} role="status">
                <span className="rumour-tag">Rumour</span>
                <b className="rumour-head">{activeRumour.bps > 0 ? "SOL to surge" : "SOL to dump"}</b>
                <b className="rumour-cd num">{Math.max(0, Math.ceil(activeRumour.at - elapsed))}s</b>
                <span className="rumour-note">Rumours are right 2 times in 3</span>
              </div>
            )}
            {closingBell && <div className="closing-bell" role="status">Final shock is double size</div>}
          </div>
        )}
        {flash && (
          <div key={flash.id} className={`newsflash ${flash.bps > 0 ? "good" : "bad"}`} role="alert">
            <span className="nf-tag">Breaking</span>
            <b className="nf-text">{flash.bps > 0 ? "SOL surges" : "SOL dumps"}</b>
            <b className="nf-move num">{pct(flash.bps)}</b>
            {flash.rumourTrue !== undefined && <span className={`nf-rumour ${flash.rumourTrue ? "truth" : "lie"}`}>{flash.rumourTrue ? "Rumour was true" : "Rumour was false"}</span>}
          </div>
        )}

        {showHowTo && (
          <section className="howto" aria-label="How to play">
            <span className="howto-title">How to play</span>
            <ul className="howto-list">
              <li>One of the six is secretly told every news shock before it hits.</li>
              <li>Buy if you think SOL jumps, Sell if you think it dumps. Every trade is public.</li>
              <li>After 60 s, accuse the insider. Right +100, wrong −50.</li>
            </ul>
          </section>
        )}
        {ui === "idle" && !showHowTo && <div className="headline quiet"><span className="kicker">Table {index + 1}</span><h2>{mySeat >= 0 ? "Get ready" : "Take a seat"}</h2><p>{mySeat >= 0 ? "The opening bell rings in a few seconds." : "Bots fill the empty desks. Any of the six can be the insider."}</p></div>}
        {ui === "deal" && !showHowTo && <div className="headline"><h2 className="pulse">Dealing secret roles</h2><p>One of the six is being tipped off inside the private rollup.</p></div>}
        {roleCard && roleCard.round === round && (
          <button type="button" className={`rolecard ${roleCard.insider ? "ins" : ""}`} onClick={() => setRoleCard(null)} aria-label="Dismiss role card">
            <div className="rc-rays" />
            <span className="rc-kicker">Your role</span>
            {mySeat >= 0 && <Avatar seat={mySeat} size={64} masked={roleCard.insider} />}
            <h2>{roleCard.insider ? "Insider" : "Trader"}</h2>
            <p>{roleCard.insider ? "You see every news shock early. Profit, but do not get caught." : "Someone knows the news early. Watch who trades just before it."}</p>
            <span className="rc-tap">Tap to dismiss</span>
          </button>
        )}
        {ui === "vote" && <div className="headline"><h2>Who was the insider?</h2><p>{mySeat >= 0 ? (canVote ? (myVote !== null ? `You accused ${SEAT_NAMES[myVote]}. Votes stay sealed until the reveal.` : "Pick your suspect. Votes stay sealed until the reveal.") : "Votes are in. Opening the envelope.") : "The floor is voting in secret."}</p></div>}
        {ui === "drum" && <div className="headline"><h2 className="pulse">The insider was</h2></div>}
        {ui === "reveal" && curSnap && (
          <div className={`headline verdict ${curSnap.caught ? "caught" : "escaped"}`} style={{ ["--c" as any]: SEAT_COLORS[curSnap.insider] }}>
            <span className="kicker">The insider was</span>
            <h2 className="culprit">{SEAT_NAMES[curSnap.insider]}{curSnap.insider === curSnap.mySeat && <em>that's you</em>}</h2>
            <div className="stamp">{curSnap.caught ? "Caught" : "Got away"}</div>
            {stage === 2 && <p>{verdictLine(curSnap)}</p>}
          </div>
        )}
      </div>

      <header className="bar">
        <div className="bar-left">
          <button className="iconbtn" onClick={onLeave} aria-label="Back to tables"><Icon name="back" /></button>
          <div className="plaque"><b>Table {index + 1}</b><span>Round {round}</span></div>
          <button
            type="button"
            className="sealed rollup-chip"
            onClick={toggleProof}
            aria-expanded={side === "proof"}
            title="The insider, the shocks and every vote are sealed inside MagicBlock's private rollup (TEE). Click to try cheating."
          >
            <Icon name="lock" size={13} />
            <span className="rollup-full">PRIVATE ROLLUP{median !== null ? ` · ${median} ms` : ""} · {moves} {moves === 1 ? "move" : "moves"}, 0 fees</span>
            <span className="rollup-short">ROLLUP{median !== null ? ` · ${median} ms` : ""}</span>
          </button>
        </div>
        <div className="bar-mid">
          {left > 0 ? (
            <div className={`clock ${accusing ? "vote" : ""} ${left < 10 ? "hot" : ""} ${closingBell ? "closing" : ""}`} role="timer" aria-label={`${Math.ceil(left)} seconds left`}>
              <svg viewBox="0 0 60 60"><circle cx="30" cy="30" r={R} className="track" /><circle cx="30" cy="30" r={R} className="fill" strokeDasharray={C} strokeDashoffset={C * (1 - Math.max(0, Math.min(1, frac)))} /></svg>
              <b className="num">{Math.ceil(left)}</b>
              <span>{accusing ? "Vote" : "Trade"}</span>
            </div>
          ) : <div className="phase">{ui === "deal" ? "Dealing" : ui === "vote" ? "Counting votes" : ui === "drum" || ui === "reveal" ? (nextIn > 0 && stage === 2 ? `Next round ${nextIn}s` : "Reveal") : "Waiting for traders"}</div>}
        </div>
        <div className="bar-right">
          {priceBox}
          <button className={`iconbtn ${side === "tape" ? "on" : ""}`} onClick={() => setSide(side === "tape" ? null : "tape")} aria-label="Trade tape" title="Trade tape"><Icon name="tape" /></button>
          <button
            className={`iconbtn cheatbtn ${side === "proof" ? "on" : ""} ${pulseProof ? "pulse-once" : ""}`}
            onClick={toggleProof}
            onAnimationEnd={markProofSeen}
            aria-label="Try to cheat"
            aria-expanded={side === "proof"}
            title="Try to cheat"
          >
            <Icon name="shield" />
            <span className="cheatbtn-label">Try to cheat</span>
          </button>
          <button className="iconbtn" onClick={() => { setMuted(!muted); setMute(!muted); }} aria-label={muted ? "Turn sound on" : "Turn sound off"} title={muted ? "Sound is off" : "Sound is on"}><Icon name={muted ? "mute" : "sound"} /></button>
        </div>
      </header>

      <div className="feed" aria-label="Latest trades">
        <div className="feed-strip">{priceBox}{seat && phase === 2 && <span className={`mine num ${myEq >= 0 ? "up" : "down"}`}>{chips(myEq)} chips</span>}</div>
        {(ui === "live" || ui === "vote") && feed.map((m, k) => (
          <div key={hist.current.marks.length - k} className={`kill ${m.delta > 0 ? "up" : "down"} ${m.seat === mySeat ? "me" : ""}`} style={{ ["--c" as any]: SEAT_COLORS[m.seat] }}>
            <Avatar seat={m.seat} size={20} /><span className="who">{SEAT_NAMES[m.seat]}</span>
            <b>{m.delta > 0 ? "BUY" : "SELL"} {Math.abs(m.delta)}</b><span className="at num">{m.t}s</span>
          </div>
        ))}
        {ui === "live" && feed.length === 0 && <div className="feed-empty">Every trade shows up here. Watch who moves just before the news.</div>}
      </div>

      <footer className="tray">
        {ui === "live" && seat && (
          <>
            {showCoach && <div className="coach" role="status">{insider ? "Trade ahead of the news without being obvious." : "Watch who trades just before the news."}</div>}
            <div className="deck">
            <button
              className={`trade sell ${pressedBtn === "sell" ? "pressed" : ""}`}
              disabled={!trading || intentPos <= -MAX_POS}
              onPointerDown={() => setPressedBtn("sell")}
              onPointerUp={() => setPressedBtn("")}
              onPointerLeave={() => setPressedBtn("")}
              onPointerCancel={() => setPressedBtn("")}
              onClick={() => trade(-1)}
            ><Icon name="down" size={22} /><span>Sell</span><kbd>↓</kbd></button>
            <div className="mypos">
              <div className="mypos-top">
                <b className={intentPos > 0 ? "up" : intentPos < 0 ? "down" : ""}>
                  {intentPos > 0 ? `Long ${intentPos}` : intentPos < 0 ? `Short ${-intentPos}` : "Flat"}
                  {intentPos !== confirmedPos && <small className="mypos-pending">pending</small>}
                </b>
                <span className={`pnl num ${myEq >= 0 ? "up" : "down"}`}>{chips(myEq)}<small>chips</small></span>
              </div>
              <div className="lots" aria-hidden="true">{Array.from({ length: MAX_POS * 2 + 1 }, (_, k) => k - MAX_POS).map((v) => {
                let cls = "";
                if (v === 0) cls = "mid";
                else if (v > 0) {
                  if (confirmedPos >= v && intentPos >= v) cls = "long";
                  else if (intentPos >= v) cls = "long pending";
                  else if (confirmedPos >= v) cls = "trim";
                } else {
                  if (confirmedPos <= v && intentPos <= v) cls = "shortp";
                  else if (intentPos <= v) cls = "shortp pending";
                  else if (confirmedPos <= v) cls = "trim";
                }
                return <i key={v} className={cls} />;
              })}</div>
              <div className="mypos-scale"><span>Short 5</span><span>Long 5</span></div>
            </div>
            <button
              className={`trade buy ${pressedBtn === "buy" ? "pressed" : ""}`}
              disabled={!trading || intentPos >= MAX_POS}
              onPointerDown={() => setPressedBtn("buy")}
              onPointerUp={() => setPressedBtn("")}
              onPointerLeave={() => setPressedBtn("")}
              onPointerCancel={() => setPressedBtn("")}
              onClick={() => trade(1)}
            ><Icon name="up" size={22} /><span>Buy</span><kbd>↑</kbd></button>
          </div>
          </>
        )}

        {(ui === "idle" || ui === "deal") && (
          <div className="waitbox">
            {mySeat >= 0 || wantSit ? <><span className="spinner" /><span>{mySeat >= 0 && <><b>You are in as {SEAT_NAMES[mySeat]}.</b> </>}<span className="state-line">{waitState}</span></span></>
              : canSit && firstOpen >= 0 ? <>
                <button className="btn gold big" disabled={busy} onClick={() => run("Seated", () => actions.sit(session, key, firstOpen))}><Icon name="seat" size={22} />Take a seat</button>
                <span className="muted">or pick a desk on the floor</span>
              </> : <span className="state-line">{waitState}</span>}
          </div>
        )}

        {(ui === "vote" || (ui === "live" && !seat)) && (
          <Evidence
            seats={t.seats}
            eq={eq}
            marks={hist.current.marks}
            shocks={t.shocks}
            rumours={hist.current.rumours}
            seatNames={SEAT_NAMES}
            seatColors={SEAT_COLORS}
            voting={ui === "vote"}
            mySeat={mySeat}
            canVote={canVote}
            myVote={myVote}
            locked={locked}
            busy={busy}
            allIn={allIn}
            onAllInChange={setAllIn}
            onAccuse={accuse}
            spectateNote={(ui === "live" || (ui === "vote" && wantSit && mySeat < 0)) ? <span className="ballot-note">{wantSit ? <><span className="spinner" /><span className="state-line">{waitState}</span></> : <><Icon name="eye" size={14} />Spectating. Seats open when this round ends.</>}</span> : undefined}
          />
        )}

        {ui === "reveal" && stage === 2 && curSnap && (
          <div className="results" ref={resultsRef}>
            <div className="results-head">
              <div className="results-summary">
                {mySnap ? (
                  <>
                    <span className={`you num ${Math.round(myLast) > 0 ? "up" : Math.round(myLast) < 0 ? "down" : ""}`}>You {chips(myLast * scoreMul)} chips</span>
                    <div className="breakdown" aria-label="Score breakdown">
                      {breakdown.map((b, idx) => (
                        <span key={idx} className={`bd-item num ${b.tone ?? ""}`}>{b.text}</span>
                      ))}
                    </div>
                  </>
                ) : (
                  <span className="you">Round {round} results</span>
                )}
              </div>
              <div className="results-actions">
                <button className="btn small" onClick={() => { setSide("proof"); cheat.verify(); }}><Icon name="shield" size={15} />Verify the draw</button>
                {nextIn > 0 && <span className="next num">Next round in {nextIn}s</span>}
              </div>
              {careerRound && <Career session={session} round={careerRound} chips={chips} />}
            </div>
            <div className="suspects">
              {ranked.map((s, rank) => (
                <div key={s.seat} className={`suspect score ${s.seat === curSnap.insider ? "insider" : ""} ${s.seat === curSnap.mySeat ? "self" : ""}`} style={{ ["--c" as any]: SEAT_COLORS[s.seat] }}>
                  <span className="s-rank">{rank + 1}</span>
                  <Avatar seat={s.seat} size={38} masked={s.seat === curSnap.insider} />
                  <span className="s-name">{s.name}{s.seat === curSnap.mySeat && <em>You</em>}</span>
                  <span className={`s-pnl num ${Math.round(s.last) > 0 ? "up" : Math.round(s.last) < 0 ? "down" : ""}`}>{chips(s.last * scoreMul)}</span>
                  {s.votesGot > 0 && <span className="s-votes"><Icon name="gavel" size={12} />{s.votesGot}</span>}
                  <span className="s-meta">{s.seat === curSnap.insider ? <b className="s-ins">Insider</b> : s.suspect !== NONE ? <>accused <i className="s-dot" style={{ background: SEAT_COLORS[s.suspect] }} />{SEAT_NAMES[s.suspect]}</> : "no vote"}</span>
                  {rank === 0 && <span className="s-top">Top trader</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </footer>

      {side && (
        <aside className="drawer" aria-label={side === "tape" ? "Trade tape" : "Try to cheat"}>
          <div className="drawer-head">
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={side === "tape"} className={side === "tape" ? "on" : ""} onClick={() => setSide("tape")}><Icon name="tape" size={15} />Trade tape</button>
              <button role="tab" aria-selected={side === "proof"} className={side === "proof" ? "on" : ""} onClick={() => setSide("proof")}><Icon name="shield" size={15} />Try to cheat</button>
            </div>
            <button className="iconbtn" onClick={() => setSide(null)} aria-label="Close panel"><Icon name="close" /></button>
          </div>
          {side === "tape" ? (
            <div className="drawer-body">
              <div className="chartbox">
                <Chart points={hist.current.points} marks={hist.current.marks} shocks={t.shocks.filter((s) => Math.abs(s.bps) > 1 && phase >= 2)} future={future} elapsed={elapsed} open={phase >= 2 ? openPrice : 0} colors={SEAT_COLORS} />
              </div>
              <div className="prints">
                {hist.current.marks.length === 0 && <p className="muted small">Every trade is public and lands here. Look for who moves just before the news.</p>}
                {[...hist.current.marks].reverse().slice(0, 60).map((m, k) => (
                  <div key={hist.current.marks.length - k} className={`print ${m.delta > 0 ? "up" : "down"}`}>
                    <span className="at num">{m.t}s</span><Avatar seat={m.seat} size={20} />
                    <span className="who">{SEAT_NAMES[m.seat]}</span>
                    <b>{m.delta > 0 ? "BUY" : "SELL"} {Math.abs(m.delta)}</b><span className="px num">${usd(m.p)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="drawer-body">
              <p className="proof-lead">On a normal chain anyone could read who the insider is. Try it here.</p>
              <div className="proof-link-row">
                <a className="proof-link" href={explorer("address", chainMod.PID.toBase58())} target="_blank" rel="noreferrer">On-chain record <span aria-hidden="true">↗</span></a>
              </div>
              <p className="muted small">Each button sends a real request from this browser, signed with your own key, to the rollup or to Solana.</p>
              <div className="cheats">
                <button onClick={cheat.secret}><Icon name="eye" size={16} /><span>Read the secret</span></button>
                <button onClick={cheat.seat}><Icon name="lock" size={16} /><span>Read another seat</span></button>
                <button onClick={cheat.solana}><Icon name="link" size={16} /><span>Read it from Solana</span></button>
                <button onClick={cheat.impersonate} disabled={!trading}><Icon name="bolt" size={16} /><span>Trade as someone else</span></button>
                <button onClick={cheat.verify} disabled={!settled}><Icon name="check" size={16} /><span>Verify the draw</span></button>
                <button onClick={cheat.ledger}><Icon name="clock" size={16} /><span>Solana record</span></button>
              </div>
              <div className="prooflog">
                {proof.length === 0 && <p className="muted small">Results appear here. “Trade as someone else” needs a live round and “Verify the draw” needs a finished one.</p>}
                {proof.map((l, k) => (
                  <div key={proof.length - k} className={`line ${l.ok ? "ok" : "bad"}`}>
                    <span className="verdict-ic"><Icon name={l.ok ? "check" : "close"} size={14} /></span>
                    <span>{l.text} {l.href && <a href={l.href} target="_blank" rel="noreferrer">Open in Explorer</a>}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
