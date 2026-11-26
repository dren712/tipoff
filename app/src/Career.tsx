import { useEffect, useMemo, useRef, useState } from "react";
import { Board, BoardEntry, Session, ZERO, boardPda, explorer, fetchBoard } from "./chain";
import { Icon } from "./Icon";
import "./css/results.css";

const CAREER_KEY = "tipoff-career-v1";
const MAX_SEEN = 200;

export type CareerRound = {
  tableId: number;
  round: string;
  played: boolean;
  lastRaw: number;
  caughtRight: boolean;
  wrongVote: boolean;
  escapedInsider: boolean;
};

type RoundDelta = { streak: number; newBest: boolean };
type LocalCareer = {
  score: number;
  rounds: number;
  caught: number;
  escapes: number;
  streak: number;
  best: number;
  seen: Record<string, RoundDelta>;
};

export function rankTitle(caught: number, escapes: number): string {
  const rank =
    caught >= 6 ? "Compliance Chief"
      : caught >= 3 ? "Detective"
        : caught >= 1 ? "Analyst"
          : "Rookie";
  return escapes >= 2 ? `${rank} · Ghost` : rank;
}

function readLocal(): LocalCareer | null {
  try {
    const raw = localStorage.getItem(CAREER_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<LocalCareer>;
    if (typeof p.rounds !== "number" || typeof p.score !== "number") return null;
    return {
      score: p.score ?? 0,
      rounds: p.rounds ?? 0,
      caught: p.caught ?? 0,
      escapes: p.escapes ?? 0,
      streak: p.streak ?? 0,
      best: p.best ?? 0,
      seen: p.seen && typeof p.seen === "object" ? p.seen : {},
    };
  } catch {
    return null;
  }
}

function syncLocal(round: CareerRound): { rec: LocalCareer | null; delta: RoundDelta | null } {
  const existing = readLocal();
  if (!round.played) return { rec: existing, delta: null };
  const key = `${round.tableId}:${round.round}`;
  const rec: LocalCareer = existing ?? {
    score: 0, rounds: 0, caught: 0, escapes: 0, streak: 0, best: 0, seen: {},
  };
  if (!rec.seen[key]) {
    const prevBest = rec.best;
    rec.score += round.lastRaw;
    rec.rounds += 1;
    if (round.caughtRight) {
      rec.caught += 1;
      rec.streak += 1;
      rec.best = Math.max(rec.best, rec.streak);
    } else if (round.wrongVote) {
      rec.streak = 0;
    }
    if (round.escapedInsider) {
      rec.escapes += 1;
    }
    const delta: RoundDelta = {
      streak: round.caughtRight && rec.streak >= 1 ? rec.streak : 0,
      newBest: rec.best > prevBest && rec.best > 0,
    };
    const keys = Object.keys(rec.seen);
    if (keys.length >= MAX_SEEN) {
      for (const old of keys.slice(0, keys.length - MAX_SEEN + 1)) delete rec.seen[old];
    }
    rec.seen[key] = delta;
    try { localStorage.setItem(CAREER_KEY, JSON.stringify(rec)); } catch {}
  }
  return { rec, delta: rec.seen[key] ?? null };
}

export function Career({ session, round, chips }: {
  session: Session;
  round: CareerRound;
  chips: (n: number) => string;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const preBest = useRef<{ roundKey: string; best: number } | null>(null);
  const local = useMemo(
    () => syncLocal(round),
    [round.tableId, round.round, round.played, round.lastRaw, round.caughtRight, round.wrongVote, round.escapedInsider],
  );

  useEffect(() => {
    let live = true;
    const roundKey = `${round.tableId}:${round.round}`;
    const load = async () => {
      const b = await fetchBoard(session).catch(() => null);
      if (!live) return;
      if (b) {
        const slot = round.tableId % Math.max(1, b.posted.length);
        const me = session.kp.publicKey;
        const mine = b.entries.find((e) => !e.player.equals(ZERO) && e.player.equals(me));
        const postedRound = b.posted[slot]?.toNumber() ?? 0;
        if (postedRound < Number(round.round) && (!preBest.current || preBest.current.roundKey !== roundKey)) {
          preBest.current = { roundKey, best: mine?.best ?? 0 };
        }
      }
      setBoard(b);
    };
    load();
    const t1 = setTimeout(load, 1800);
    const t2 = setTimeout(load, 4000);
    return () => { live = false; clearTimeout(t1); clearTimeout(t2); };
  }, [session, round.tableId, round.round]);

  const me = session.kp.publicKey;
  let onChainEntry: BoardEntry | null = null;
  let posLabel = "";
  let boardHasRound = false;
  if (board) {
    const active = board.entries.filter((e) => !e.player.equals(ZERO));
    const sorted = [...active].sort((a, b) => b.score.cmp(a.score));
    const idx = sorted.findIndex((e) => e.player.equals(me));
    if (idx >= 0) {
      onChainEntry = sorted[idx];
      posLabel = `#${idx + 1} of ${board.entries.length}`;
    }
    const slot = round.tableId % Math.max(1, board.posted.length);
    boardHasRound = (board.posted[slot]?.toNumber() ?? 0) >= Number(round.round);
  }

  if (!round.played && !onChainEntry && !local.rec) return null;

  const totalRaw = onChainEntry ? onChainEntry.score.toNumber() : (local.rec?.score ?? 0);
  const totalChips = totalRaw / 1e6;
  const totalRounded = Math.round(totalChips);
  const caught = onChainEntry ? onChainEntry.caught : (local.rec?.caught ?? 0);
  const escapes = onChainEntry ? onChainEntry.escapes : (local.rec?.escapes ?? 0);
  const streak = onChainEntry ? onChainEntry.streak : (local.rec?.streak ?? 0);
  const title = rankTitle(caught, escapes);

  const roundKey = `${round.tableId}:${round.round}`;
  const streakDelta = round.played && round.caughtRight
    ? (onChainEntry ? (boardHasRound ? streak : 0) : local.delta?.streak ?? 0)
    : 0;
  const onChainNewBest = onChainEntry && boardHasRound && round.played && round.caughtRight
    ? (preBest.current?.roundKey === roundKey
      ? onChainEntry.best > preBest.current.best && onChainEntry.best > 0
      : onChainEntry.streak > 0 && onChainEntry.streak === onChainEntry.best && (!!local.delta?.newBest || onChainEntry.rounds === 1 || onChainEntry.streak >= 2))
    : false;
  const isNewBest = onChainEntry && boardHasRound ? onChainNewBest : !!local.delta?.newBest;

  return (
    <div className="career" aria-label="Career record">
      <div className="career-main">
        <span className="career-rank">{title}</span>
        {posLabel && <span className="career-pos num">{posLabel}</span>}
        {streakDelta >= 1 && <span className="career-delta up">Streak {streakDelta}</span>}
        {isNewBest && <span className="career-delta gold">New best</span>}
        {round.played && round.escapedInsider && <span className="career-delta gold">Escaped</span>}
      </div>
      <div className="career-stats">
        <span className="career-stat">
          Total <b className={`num ${totalRounded > 0 ? "up" : totalRounded < 0 ? "down" : ""}`}>{chips(totalChips)}</b>
        </span>
        <span className="career-stat">Caught <b className="num">{caught}</b></span>
        <span className="career-stat">Streak <b className="num">{streak}</b></span>
        {onChainEntry ? (
          <a
            className="career-src chain"
            href={explorer("address", boardPda().toBase58())}
            target="_blank"
            rel="noreferrer"
          >
            Kept on Solana <Icon name="link" size={12} />
          </a>
        ) : (
          <span className="career-src local">Saved in this browser</span>
        )}
      </div>
    </div>
  );
}
