import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FIRST_TABLE, MAX_POS, NONE, ROUND_SECS, SEATS, Session, Table, SeatPrivate, VOTE_SECS, ZERO, actions, base, equity, explorer,
  fetchSeat, fetchTable, ledgerPda, redraw, secretPda, seatPda, short, tablePda,
} from "./chain";
import { Chart, Point, Mark } from "./Chart";
import { Avatar, SEAT_COLORS, SEAT_NAMES } from "./Avatar";
import { isMuted, setMuted, sfx } from "./sound";

const chips = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(0)}`;
const pct = (bps: number) => `${bps > 0 ? "+" : "−"}${(Math.abs(bps) / 100).toFixed(1)}%`;
const usd = (p: number) => (p / 1e8).toFixed(2);
type Line = { ok: boolean; text: string; href?: string };
type Pop = { id: number; delta: number };
type Hist = { round: string; points: Point[]; marks: Mark[]; seen: number; shocks: number; phase: number };

export function TableView({ session, index, onLeave, onLatency }: { session: Session; index: number; onLeave: () => void; onLatency: (ms: number) => void }) {
  const key = useMemo(() => tablePda(FIRST_TABLE + index), [index]);
  const [t, setT] = useState<Table | null>(null);
  const [now, setNow] = useState(Date.now() / 1000);
  const [priv, setPriv] = useState<SeatPrivate | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [proof, setProof] = useState<Line[]>([]);
  const [side, setSide] = useState<"tape" | "proof">("tape");
  const [pops, setPops] = useState<Record<number, Pop>>({});
  const [flash, setFlash] = useState<{ id: number; bps: number } | null>(null);
  const [roleCard, setRoleCard] = useState<{ round: string; insider: boolean } | null>(null);
  const [stage, setStage] = useState(2); // reveal: 0 drum roll, 1 unmask, 2 scores
  const [muted, setMute] = useState(isMuted());
  const hist = useRef<Hist>({ round: "", points: [], marks: [], seen: 0, shocks: 0, phase: -1 });
  const shownRole = useRef("");
  const me = session.kp.publicKey;
  const mySeatRef = useRef(-1);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const next = await fetchTable(session, key).catch(() => null);
      if (!live || !next) return;
      const round = next.round.toString();
      if (hist.current.round !== round)
        hist.current = { round, points: [], marks: [], seen: next.phase === 2 ? Math.max(0, next.tapeLen - next.tape.length) : next.tapeLen, shocks: next.phase === 2 ? next.shocksSeen : 0, phase: hist.current.phase };
      const h = hist.current;
      const first = h.phase === -1;
      if (next.phase === 2) {
        const el = Math.min(ROUND_SECS, Date.now() / 1000 - next.tStart.toNumber());
        if (el >= 0) h.points.push({ t: el, p: next.price.toNumber() });
        const fresh: Record<number, Pop> = {};
        for (let k = h.seen; k < next.tapeLen; k++) {
          const p = next.tape[k % next.tape.length];
          h.marks.push({ t: p.t, p: p.price.toNumber(), seat: p.seat, delta: p.delta });
          fresh[p.seat] = { id: k, delta: p.delta };
          if (!first && p.seat !== mySeatRef.current) sfx.tick(p.delta > 0);
        }
        if (Object.keys(fresh).length && !first) setPops((o) => ({ ...o, ...fresh }));
        h.seen = next.tapeLen;
        if (next.shocksSeen > h.shocks) {
          const bps = next.shocks[next.shocksSeen - 1].bps;
          if (!first) { setFlash({ id: Date.now(), bps }); sfx.news(bps > 0); }
          h.shocks = next.shocksSeen;
        }
        if (h.phase === 1) sfx.bell();
      }
      if (next.phase === 3 && h.phase === 2) {
        setStage(0);
        sfx.drum();
        setTimeout(() => { setStage(1); next.caught ? sfx.caught() : sfx.escaped(); }, 1600);
        setTimeout(() => setStage(2), 4200);
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

  const run = useCallback(async (label: string, fn: () => Promise<{ sig: string; ms: number }>) => {
    setBusy(true);
    try {
      const r = await fn();
      onLatency(r.ms);
      setToast(`${label} · ${r.ms} ms`);
    } catch (e: any) {
      setToast(`${label} failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }, [onLatency]);

  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(""), 3000); return () => clearTimeout(id); }, [toast]);
  useEffect(() => { if (!flash) return; const id = setTimeout(() => setFlash(null), 2200); return () => clearTimeout(id); }, [flash]);

  const elapsed = t && phase === 2 ? now - t.tStart.toNumber() : 0;
  const trading = phase === 2 && elapsed < ROUND_SECS;
  const accusing = phase === 2 && elapsed >= ROUND_SECS;
  const canVote = phase === 2 && elapsed < ROUND_SECS + VOTE_SECS;
  const seat = t && mySeat >= 0 ? t.seats[mySeat] : null;
  const current = priv && t && priv.round.eq(t.round) ? priv : null;
  const insider = current?.role === 2 && phase === 2;
  const myVote = current && current.vote !== NONE ? current.vote : null;
  const price = t?.price.toNumber() ?? 0;
  const openPrice = t?.openPrice.toNumber() ?? 0;

  // Deal the role card once per round.
  useEffect(() => {
    if (!current || phase !== 2 || elapsed > 12 || shownRole.current === round) return;
    shownRole.current = round;
    setRoleCard({ round, insider: current.role === 2 });
    sfx.role(current.role === 2);
  }, [current, phase, round, elapsed]);
  useEffect(() => { if (!roleCard) return; const id = setTimeout(() => setRoleCard(null), 3000); return () => clearTimeout(id); }, [roleCard]);

  const trade = (d: number) => {
    if (!seat || !trading || busy) return;
    sfx.mine(d > 0);
    run(d > 0 ? `Bought ${d}` : `Sold ${-d}`, () => actions.trade(session, key, mySeat, d));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!seat) return;
      if (e.key === "ArrowUp" && seat.pos < MAX_POS) { e.preventDefault(); trade(1); }
      if (e.key === "ArrowDown" && seat.pos > -MAX_POS) { e.preventDefault(); trade(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!t) return <div className="center muted">Loading table…</div>;

  const seated = t.seats.some((s) => !s.player.equals(ZERO));
  const settled = phase === 3 && seated;
  const canSit = mySeat < 0 && (phase === 0 || phase === 3);
  const nextIn = settled ? Math.max(0, Math.ceil(t.settledAt.toNumber() + 12 - now)) : 0;
  const future = insider ? current!.shocks.filter((s) => s.at > elapsed) : [];
  const nextShock = future[0];
  const accuse = (i: number) => { sfx.vote(); run(`Accused ${SEAT_NAMES[i]}`, () => actions.vote(session, key, mySeat, i)); };
  const votesFor = (i: number) => (settled && stage >= 1 ? t.votes.filter((v, k) => v === i && k !== t.insider).length : 0);

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

  const seatEl = (i: number) => {
    const s = t.seats[i];
    const empty = s.player.equals(ZERO);
    const eq = phase === 2 ? equity(s, price, openPrice) : 0;
    const pop = pops[i];
    const unmasked = settled && stage >= 1 && t.insider === i;
    const last = s.last.toNumber() / 1e6;
    return (
      <div key={i} className={`trader ${i === mySeat ? "me" : ""} ${unmasked ? "unmasked" : ""} ${settled && stage === 0 ? "suspense" : ""}`} style={{ ["--c" as any]: SEAT_COLORS[i] }}>
        {pop && phase === 2 && <span key={pop.id} className={`pop ${pop.delta > 0 ? "up" : "down"}`}>{pop.delta > 0 ? "▲ BUY" : "▼ SELL"} {Math.abs(pop.delta)}</span>}
        {votesFor(i) > 0 && <span className="votes" title="Accusations received">{votesFor(i)} {votesFor(i) === 1 ? "vote" : "votes"}</span>}
        <div className="face"><Avatar seat={i} empty={empty} masked={unmasked || (i === mySeat && insider)} mood={phase === 2 ? Math.sign(Math.round(eq)) : settled && stage === 2 ? Math.sign(last) : 0} /></div>
        <div className="plate">
          <b>{empty ? "Empty" : SEAT_NAMES[i]}{i === mySeat && <em> you</em>}</b>
          {empty ? (canSit ? <button className="sit" disabled={busy} onClick={() => run("Seated", () => actions.sit(session, key, i))}>Sit here</button> : <span className="muted small">open seat</span>)
            : phase === 2 ? (
              <span className="posrow">
                <span className="lots sm">{Array.from({ length: MAX_POS * 2 + 1 }, (_, k) => k - MAX_POS).map((v) => (
                  <i key={v} className={v === 0 ? "mid" : (v > 0 && s.pos >= v) || (v < 0 && s.pos <= v) ? (v > 0 ? "long" : "shortp") : ""} />))}</span>
                <span className={eq >= 0 ? "up" : "down"}>{chips(eq)}</span>
              </span>
            ) : settled && stage === 2 ? <span className={last >= 0 ? "up big" : "down big"}>{chips(last)}</span>
            : <span className="muted small">{chips(s.score.toNumber() / 1e6)} total</span>}
        </div>
        {i === mySeat && !trading && !canVote && phase !== 1 && <button className="leave" disabled={busy} onClick={() => run("Left the table", () => actions.stand(session, key, i))}>Leave</button>}
      </div>
    );
  };

  return (
    <main className={`game ${insider ? "asinsider" : ""}`}>
      <div className="topline">
        <button className="ghost" onClick={onLeave}>← Tables</button>
        <b>Table {index + 1}</b><span className="muted">Round {round}</span>
        <span className="grow" />
        {mySeat >= 0 && phase === 2 && current && <span className={`badge ${insider ? "ins" : ""}`}>{insider ? "You are the INSIDER" : "You are a trader"}</span>}
        <button className="ghost" onClick={() => { setMuted(!muted); setMute(!muted); }} aria-label={muted ? "Turn sound on" : "Turn sound off"}>{muted ? "Sound off" : "Sound on"}</button>
      </div>

      <div className="scene">
        <div className="pit">
          <div className="rowseats">{[0, 1, 2].map(seatEl)}</div>
          <div className={`board ${flash ? (flash.bps > 0 ? "shakeup" : "shakedown") : ""}`}>
            <div className="pricebar">
              <span className="price">{price ? `$${usd(price)}` : "—"}</span>
              {openPrice > 0 && phase >= 2 && <span className={price >= openPrice ? "up" : "down"}>{pct(((price - openPrice) / openPrice) * 10000)}</span>}
              <span className="muted small">SOL/USD live</span>
              <span className="grow" />
              {trading && <span className={`timer ${ROUND_SECS - elapsed < 10 ? "hot" : ""}`}><i style={{ width: `${(elapsed / ROUND_SECS) * 100}%` }} /><b>{Math.ceil(ROUND_SECS - elapsed)}</b></span>}
            </div>
            <Chart points={hist.current.points} marks={hist.current.marks} shocks={t.shocks.filter((s) => s.bps !== 0)} future={future} elapsed={phase === 2 ? Math.min(elapsed, ROUND_SECS) : settled ? ROUND_SECS : 0} open={openPrice} colors={SEAT_COLORS} />

            {flash && <div key={flash.id} className={`newsflash ${flash.bps > 0 ? "good" : "bad"}`}><span>BREAKING</span><b>{flash.bps > 0 ? "SOL SURGES" : "SOL DUMPS"} {pct(flash.bps)}</b></div>}
            {insider && trading && nextShock && (
              <div className="tip"><span>TIP-OFF</span> News in <b>{Math.max(0, Math.ceil(nextShock.at - elapsed))}s</b>: <b className={nextShock.bps > 0 ? "up" : "down"}>{pct(nextShock.bps)}</b></div>
            )}
            {(phase === 0 || (phase === 3 && !seated)) && <div className="overlay soft"><h2>{mySeat >= 0 ? "Dealing you in…" : "Take a seat to play"}</h2><p>Bots fill the empty seats. One of the six will be the insider.</p></div>}
            {phase === 1 && <div className="overlay"><div className="cards">{Array.from({ length: SEATS }, (_, k) => <i key={k} style={{ animationDelay: `${k * 0.12}s` }} />)}</div><h2>Dealing secret roles</h2><p>MagicBlock VRF is picking the insider inside the private rollup.</p></div>}
            {roleCard && roleCard.round === round && (
              <div className="overlay"><div className={`rolecard ${roleCard.insider ? "ins" : ""}`}>
                <Avatar seat={Math.max(mySeat, 0)} masked={roleCard.insider} size={110} />
                <span>Your role</span><h2>{roleCard.insider ? "INSIDER" : "TRADER"}</h2>
                <p>{roleCard.insider ? "You see every news shock early. Profit, but do not get caught." : "Someone knows the news early. Watch who trades just before it."}</p>
              </div></div>
            )}
            {accusing && (
              <div className="overlay">
                <h2>Who was the insider?</h2>
                <p>{mySeat >= 0 ? (canVote ? "Pick one. Right: +100 and a share of their profit. Wrong: −50." : "Votes are in. Settling…") : "The table is voting in secret."}</p>
                <div className="lineup">{t.seats.map((s, i) => i !== mySeat && !s.player.equals(ZERO) && (
                  <button key={i} className={myVote === i ? "picked" : ""} disabled={busy || mySeat < 0 || !canVote} onClick={() => accuse(i)}>
                    <Avatar seat={i} size={64} /><b>{SEAT_NAMES[i]}</b>{myVote === i && <em>accused</em>}
                  </button>))}</div>
                {canVote && <span className="timer wide hot"><i style={{ width: `${((elapsed - ROUND_SECS) / VOTE_SECS) * 100}%` }} /><b>{Math.ceil(ROUND_SECS + VOTE_SECS - elapsed)}</b></span>}
              </div>
            )}
            {settled && stage === 0 && <div className="overlay"><h2 className="pulse">The insider was…</h2></div>}
            {settled && stage >= 1 && (
              <div className={`overlay reveal ${t.caught ? "caught" : "escaped"}`}>
                <Avatar seat={t.insider} masked size={120} />
                <h2>{SEAT_NAMES[t.insider]}{t.insider === mySeat ? " (you)" : ""}</h2>
                <div className="stamp">{t.caught ? "CAUGHT" : "GOT AWAY"}</div>
                {stage === 2 && (
                  <>
                    <p>{t.caught ? "Fined 100 chips. Their profit is split between the accusers." : "Nobody pinned it on them. Their profit doubles."}</p>
                    {seat && <div className={`mine ${seat.last.toNumber() >= 0 ? "up" : "down"}`}>You: {chips(seat.last.toNumber() / 1e6)} chips</div>}
                    <p className="muted small">{mySeat >= 0 ? `Next round in ${nextIn}s` : canSit ? "Take an empty seat to join the next round" : ""}</p>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="rowseats">{[3, 4, 5].map(seatEl)}</div>
        </div>

        <aside className="sidebar">
          <div className="tabs">
            <button className={side === "tape" ? "on" : ""} onClick={() => setSide("tape")}>Trade tape</button>
            <button className={side === "proof" ? "on" : ""} onClick={() => setSide("proof")}>Try to cheat</button>
          </div>
          {side === "tape" ? (
            <div className="prints">
              {hist.current.marks.length === 0 && <span className="muted small">Every trade shows up here for everyone. Look for who moves just before the news.</span>}
              {[...hist.current.marks].reverse().slice(0, 60).map((m, k) => (
                <div key={hist.current.marks.length - k} className="print">
                  <span className="muted">{m.t}s</span><Avatar seat={m.seat} size={20} />
                  <span>{SEAT_NAMES[m.seat]}</span><b className={m.delta > 0 ? "up" : "down"}>{m.delta > 0 ? "▲" : "▼"} {Math.abs(m.delta)}</b>
                </div>
              ))}
            </div>
          ) : (
            <div className="proofbox">
              <p className="muted small">Real requests from your browser, with your own key, against the rollup and Solana.</p>
              <div className="cheats">
                <button onClick={cheat.secret}>Read the secret</button>
                <button onClick={cheat.seat}>Read another seat</button>
                <button onClick={cheat.solana}>Read it from Solana</button>
                <button onClick={cheat.impersonate} disabled={!trading}>Trade as someone else</button>
                <button onClick={cheat.verify} disabled={!settled}>Verify the draw</button>
                <button onClick={cheat.ledger}>Solana record</button>
              </div>
              {proof.map((l, k) => (
                <div key={proof.length - k} className={`line ${l.ok ? "ok" : "bad"}`}>{l.ok ? "✓" : "✗"} {l.text} {l.href && <a href={l.href} target="_blank" rel="noreferrer">Explorer</a>}</div>
              ))}
            </div>
          )}
        </aside>
      </div>

      <div className="deck">
        {seat ? (
          <>
            <button className="sell" disabled={!trading || seat.pos <= -MAX_POS} onClick={() => trade(-1)}>▼ SELL <kbd>↓</kbd></button>
            <div className="mypos">
              <div className="lots">{Array.from({ length: MAX_POS * 2 + 1 }, (_, k) => k - MAX_POS).map((v) => (
                <i key={v} className={v === 0 ? "mid" : (v > 0 && seat.pos >= v) || (v < 0 && seat.pos <= v) ? (v > 0 ? "long" : "shortp") : ""} />))}</div>
              <b>{seat.pos > 0 ? `Long ${seat.pos}` : seat.pos < 0 ? `Short ${-seat.pos}` : "Flat"}</b>
              {phase === 2 && <span className={equity(seat, price, openPrice) >= 0 ? "up" : "down"}>{chips(equity(seat, price, openPrice))} chips</span>}
            </div>
            <button className="buy" disabled={!trading || seat.pos >= MAX_POS} onClick={() => trade(1)}>▲ BUY <kbd>↑</kbd></button>
          </>
        ) : <span className="muted">{canSit ? "Click “Sit here” on an empty seat to play the next round." : "You are watching this round. Seats open when it ends."}</span>}
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
