import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  FIRST_TABLE, MAX_POS, NONE, PID, ROUND_SECS, SEATS, Session, TABLES, Table, SeatPrivate, VOTE_SECS, ZERO, actions,
  base, equity, explorer, fetchSeat, fetchTable, guestKey, ledgerPda, openSession, redraw, secretPda, seatPda, short, tablePda,
} from "./chain";
import { Chart, Point, Mark } from "./Chart";

export const SEAT_NAMES = ["Coral", "Amber", "Lime", "Teal", "Azure", "Violet"];
export const SEAT_COLORS = ["#ff6b6b", "#f5b83d", "#9be564", "#3dd6c6", "#5aa9ff", "#b48cff"];
const chips = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}`;
const pct = (bps: number) => `${bps > 0 ? "+" : "−"}${(Math.abs(bps) / 100).toFixed(1)}%`;
const usd = (p: number) => (p / 1e8).toFixed(3);

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [open, setOpenState] = useState<number | null>(() => {
    const n = Number(location.hash.slice(1)) - 1;
    return location.hash.length > 1 && n >= 0 && n < TABLES ? n : null;
  });
  const setOpen = (i: number | null) => { history.replaceState(null, "", i === null ? location.pathname : `#${i + 1}`); setOpenState(i); };
  const [lat, setLat] = useState<number[]>([]);

  useEffect(() => {
    openSession(guestKey()).then(setSession).catch((e) => setError(String(e?.message ?? e)));
  }, []);
  const median = useMemo(() => (lat.length ? [...lat].sort((a, b) => a - b)[lat.length >> 1] : null), [lat]);

  return (
    <div className="app">
      <header>
        <button className="brand" onClick={() => setOpen(null)}>
          <svg viewBox="0 0 32 32" width="26" height="26"><path d="M4 22l8-8 5 4 11-12" stroke="currentColor" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Tipoff
        </button>
        <span className="tag">Solana devnet · MagicBlock private rollup</span>
        <span className="grow" />
        {median !== null && <span className="chip" title="Median time for your last moves to confirm on the rollup">{median} ms per move</span>}
        {session && <span className="chip" title="A key made in this browser signs your moves. No wallet, no fees.">Guest {short(session.kp.publicKey)}</span>}
      </header>
      {error && <div className="banner bad">Could not reach the rollup: {error}. <button onClick={() => location.reload()}>Retry</button></div>}
      {!session && !error && <div className="center muted">Signing in to the private rollup…</div>}
      {session && open === null && <Lobby session={session} onOpen={setOpen} />}
      {session && open !== null && (
        <TableView key={open} session={session} index={open} onLeave={() => setOpen(null)} onLatency={(ms) => setLat((l) => [...l.slice(-19), ms])} />
      )}
      <footer>
        Play chips only, no real money. Program <a href={explorer("address", PID.toBase58())} target="_blank" rel="noreferrer">{short(PID)}</a>
      </footer>
    </div>
  );
}

function phaseLabel(t: Table, now: number): string {
  if (t.phase === 1) return "Drawing the insider";
  if (t.phase === 2) {
    const left = t.tStart.toNumber() + ROUND_SECS - now;
    return left > 0 ? `Trading, ${Math.ceil(left)}s left` : "Final accusations";
  }
  return t.seats.some((s) => !s.player.equals(ZERO)) ? "Starting soon" : "Open";
}

function Lobby({ session, onOpen }: { session: Session; onOpen: (i: number) => void }) {
  const [tables, setTables] = useState<(Table | null)[]>([]);
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const all = await Promise.all(Array.from({ length: TABLES }, (_, i) => fetchTable(session, tablePda(FIRST_TABLE + i)).catch(() => null)));
      if (live) { setTables(all); setNow(Date.now() / 1000); }
    };
    load();
    const id = setInterval(load, 1500);
    return () => { live = false; clearInterval(id); };
  }, [session]);

  return (
    <main className="lobby">
      <section className="hero">
        <h1>One trader sees the news early. <em>Find them.</em></h1>
        <p>Six traders, one live SOL price, 60 seconds. Four news shocks will hit the price. One player, picked in secret, already knows when and which way.</p>
        <ol className="steps">
          <li><b>Trade</b><span>Buy and sell instantly. No wallet popups, no fees.</span></li>
          <li><b>Watch</b><span>Every trade is public. Who moved just before the news?</span></li>
          <li><b>Accuse</b><span>Cast a sealed vote. Catch the insider and take their profit.</span></li>
        </ol>
      </section>
      <section className="tables">
        {Array.from({ length: TABLES }, (_, i) => {
          const t = tables[i];
          const seated = t ? t.seats.filter((s) => !s.player.equals(ZERO)).length : 0;
          return (
            <button key={i} className="tablecard" onClick={() => onOpen(i)} disabled={!t}>
              <div className="row"><b>Table {i + 1}</b><span className={`dot ${t?.phase === 2 ? "on" : ""}`} /></div>
              <div className="pips">{Array.from({ length: SEATS }, (_, k) => <i key={k} style={{ background: t && !t.seats[k].player.equals(ZERO) ? SEAT_COLORS[k] : undefined }} />)}</div>
              <div className="muted">{t ? phaseLabel(t, now) : "Loading…"}</div>
              <div className="row small"><span>{seated}/{SEATS} seated</span><span>{t ? `Round ${t.round.toString()}` : ""}</span></div>
              <span className="cta">{t && (t.phase === 1 || t.phase === 2) ? "Watch" : "Take a seat"}</span>
            </button>
          );
        })}
      </section>
      <p className="muted small center">Bots fill empty seats when a round starts, so you can play alone. Any of them can be the insider.</p>
    </main>
  );
}

type Line = { ok: boolean; text: string; href?: string };

function TableView({ session, index, onLeave, onLatency }: { session: Session; index: number; onLeave: () => void; onLatency: (ms: number) => void }) {
  const key = useMemo(() => tablePda(FIRST_TABLE + index), [index]);
  const [t, setT] = useState<Table | null>(null);
  const [now, setNow] = useState(Date.now() / 1000);
  const [priv, setPriv] = useState<SeatPrivate | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");
  const [proof, setProof] = useState<Line[]>([]);
  const [showProof, setShowProof] = useState(true);
  const hist = useRef<{ round: string; points: Point[]; marks: Mark[]; seen: number }>({ round: "", points: [], marks: [], seen: 0 });
  const me = session.kp.publicKey;

  useEffect(() => {
    let live = true;
    const load = async () => {
      const next = await fetchTable(session, key).catch(() => null);
      if (!live || !next) return;
      const h = hist.current;
      const round = next.round.toString();
      if (h.round !== round) hist.current = { round, points: [], marks: [], seen: next.phase === 2 ? Math.max(0, next.tapeLen - next.tape.length) : next.tapeLen };
      const cur = hist.current;
      if (next.phase === 2) {
        const el = Math.min(ROUND_SECS, Date.now() / 1000 - next.tStart.toNumber());
        if (el >= 0) cur.points.push({ t: el, p: next.price.toNumber() });
        for (let k = cur.seen; k < next.tapeLen; k++) {
          const p = next.tape[k % next.tape.length];
          cur.marks.push({ t: p.t, p: p.price.toNumber(), seat: p.seat, delta: p.delta });
        }
        cur.seen = next.tapeLen;
      }
      setT(next);
      setNow(Date.now() / 1000);
    };
    load();
    const id = setInterval(load, 350);
    return () => { live = false; clearInterval(id); };
  }, [session, key]);

  const mySeat = t ? t.seats.findIndex((s) => s.player.equals(me)) : -1;
  const round = t?.round.toString() ?? "";
  const phase = t?.phase ?? 0;

  // The seat's private account: only this browser's key can read it.
  useEffect(() => {
    if (mySeat < 0) { setPriv(null); return; }
    let live = true;
    const load = () => fetchSeat(session, key, mySeat).then((p) => live && setPriv(p)).catch(() => {});
    load();
    const id = setInterval(load, 2500);
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

  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(""), 3500); return () => clearTimeout(id); }, [toast]);

  const elapsed = t && phase === 2 ? now - t.tStart.toNumber() : 0;
  const trading = phase === 2 && elapsed < ROUND_SECS;
  const voting = phase === 2 && elapsed < ROUND_SECS + VOTE_SECS;
  const seat = t && mySeat >= 0 ? t.seats[mySeat] : null;
  const current = priv && t && priv.round.eq(t.round) ? priv : null;
  const insider = current?.role === 2 && phase === 2;
  const myVote = current && current.vote !== NONE ? current.vote : null;
  const price = t?.price.toNumber() ?? 0;
  const openPrice = t?.openPrice.toNumber() ?? 0;

  const trade = (d: number) => seat && trading && run(d > 0 ? `Bought ${d}` : `Sold ${-d}`, () => actions.trade(session, key, mySeat, d));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy || !trading || !seat) return;
      if (e.key === "ArrowUp" && seat.pos < MAX_POS) trade(1);
      if (e.key === "ArrowDown" && seat.pos > -MAX_POS) trade(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!t) return <div className="center muted">Loading table…</div>;

  const settled = phase === 3;
  const canSit = mySeat < 0 && (phase === 0 || phase === 3);
  const nextIn = settled ? Math.max(0, Math.ceil(t.settledAt.toNumber() + 12 - now)) : 0;
  const future = insider ? current!.shocks.filter((s) => s.at > elapsed) : [];
  const nextShock = future[0];

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

  return (
    <main className="table">
      <div className="topline">
        <button className="ghost" onClick={onLeave}>← Tables</button>
        <b>Table {index + 1}</b><span className="muted">Round {round}</span>
        <span className="grow" />
        <Status t={t} now={now} seated={mySeat >= 0} />
      </div>

      {mySeat >= 0 && phase === 2 && current && (
        <div className={`role ${insider ? "insider" : ""}`}>
          {insider ? (
            <><b>You are the insider.</b> You see the news before it hits. Profit doubles if you are not caught.
              {nextShock && trading && <span className="next">Next: <b>{pct(nextShock.bps)}</b> in <b>{Math.max(0, Math.ceil(nextShock.at - elapsed))}s</b></span>}</>
          ) : (
            <><b>You are a trader.</b> One player knows the news in advance. Watch who trades just before each shock, then accuse them.</>
          )}
        </div>
      )}

      <div className="grid">
        <section className="panel chart">
          <div className="pricebar">
            <span className="price">{price ? `$${usd(price)}` : "—"}</span>
            {openPrice > 0 && phase >= 2 && <span className={price >= openPrice ? "up" : "down"}>{pct(((price - openPrice) / openPrice) * 10000)}</span>}
            <span className="muted small">SOL/USD oracle + news shocks</span>
            <span className="grow" />
            {phase === 2 && <Clock elapsed={elapsed} />}
          </div>
          <Chart points={hist.current.points} marks={hist.current.marks} shocks={t.shocks.filter((s) => s.bps !== 0)} future={future} elapsed={phase === 2 ? Math.min(elapsed, ROUND_SECS) : settled ? ROUND_SECS : 0} open={openPrice} colors={SEAT_COLORS} />
          {seat ? (
            <div className="controls">
              <div className="pos">
                <span className="muted small">Your position</span>
                <div className="lots">{Array.from({ length: MAX_POS * 2 + 1 }, (_, k) => k - MAX_POS).map((v) => (
                  <i key={v} className={v === 0 ? "mid" : (v > 0 && seat.pos >= v) || (v < 0 && seat.pos <= v) ? (v > 0 ? "long" : "shortp") : ""} />))}</div>
                <b>{seat.pos > 0 ? `Long ${seat.pos}` : seat.pos < 0 ? `Short ${-seat.pos}` : "Flat"}</b>
                {phase === 2 && <span className={equity(seat, price, openPrice) >= 0 ? "up" : "down"}>{chips(equity(seat, price, openPrice))} chips</span>}
              </div>
              <div className="buttons">
                <button className="sell" disabled={busy || !trading || seat.pos <= -MAX_POS} onClick={() => trade(-1)}>Sell 1 <kbd>↓</kbd></button>
                <button className="buy" disabled={busy || !trading || seat.pos >= MAX_POS} onClick={() => trade(1)}>Buy 1 <kbd>↑</kbd></button>
              </div>
            </div>
          ) : (
            <div className="controls"><span className="muted">{canSit ? "Pick an open seat to play the next round." : "You are watching. Seats open between rounds."}</span></div>
          )}
        </section>

        <section className="panel seats">
          <h3>Traders {voting && seat && <span className="muted small">tap Accuse to cast your sealed vote</span>}</h3>
          {t.seats.map((s, i) => {
            const empty = s.player.equals(ZERO);
            const eq = phase === 2 ? equity(s, price, openPrice) : 0;
            return (
              <div key={i} className={`seat ${i === mySeat ? "me" : ""} ${settled && t.insider === i ? "wasinsider" : ""}`}>
                <i className="swatch" style={{ background: SEAT_COLORS[i] }} />
                <div className="who">
                  <b>{SEAT_NAMES[i]}{i === mySeat && " (you)"}</b>
                  <span className="muted small">{empty ? "Open seat" : `${short(s.player)} · ${s.score.toNumber() >= 0 ? "+" : "−"}${Math.abs(s.score.toNumber() / 1e6).toFixed(0)} total`}</span>
                </div>
                {!empty && phase === 2 && (
                  <div className="stat"><b>{s.pos > 0 ? `+${s.pos}` : s.pos}</b><span className={eq >= 0 ? "up small" : "down small"}>{chips(eq)}</span></div>
                )}
                {!empty && settled && (
                  <div className="stat">
                    <b className={s.last.toNumber() >= 0 ? "up" : "down"}>{chips(s.last.toNumber() / 1e6)}</b>
                    <span className="muted small">{t.insider === i ? "Insider" : t.votes[i] === NONE ? "No vote" : `Accused ${SEAT_NAMES[t.votes[i]]}`}</span>
                  </div>
                )}
                {empty && canSit && <button className="act" disabled={busy} onClick={() => run("Seated", () => actions.sit(session, key, i))}>Sit</button>}
                {!empty && voting && seat && i !== mySeat && (
                  <button className={`act ${myVote === i ? "voted" : ""}`} disabled={busy} onClick={() => run(`Accused ${SEAT_NAMES[i]}`, () => actions.vote(session, key, mySeat, i))}>
                    {myVote === i ? "Accused" : "Accuse"}
                  </button>
                )}
                {i === mySeat && !trading && !voting && phase !== 1 && (
                  <button className="act" disabled={busy} onClick={() => run("Left the table", () => actions.stand(session, key, i))}>Leave</button>
                )}
              </div>
            );
          })}
          {settled && (
            <div className={`result ${t.caught ? "caught" : "escaped"}`}>
              <b>{SEAT_NAMES[t.insider]} was the insider {t.caught ? "and got caught." : "and got away with it."}</b>
              <span>{t.caught ? "Their profit went to the players who accused them." : "Their profit doubled."} {mySeat >= 0 ? `Next round in ${nextIn}s.` : ""}</span>
            </div>
          )}
        </section>

        <section className="panel tape">
          <h3>Trade tape</h3>
          <div className="prints">
            {hist.current.marks.length === 0 && <span className="muted small">Every trade shows up here for everyone.</span>}
            {[...hist.current.marks].reverse().slice(0, 40).map((m, k) => (
              <div key={hist.current.marks.length - k} className="print">
                <span className="muted">{m.t}s</span><i className="swatch" style={{ background: SEAT_COLORS[m.seat] }} />
                <span>{SEAT_NAMES[m.seat]}</span><b className={m.delta > 0 ? "up" : "down"}>{m.delta > 0 ? "bought" : "sold"} {Math.abs(m.delta)}</b>
                <span className="muted">${usd(m.p)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel proof">
          <h3><button className="ghost" onClick={() => setShowProof((v) => !v)}>{showProof ? "▾" : "▸"} Try to cheat, then verify</button></h3>
          {showProof && (
            <>
              <p className="muted small">These run real requests against the rollup and Solana from your browser, with your own key.</p>
              <div className="cheats">
                <button onClick={cheat.secret}>Read the secret</button>
                <button onClick={cheat.seat}>Read another seat</button>
                <button onClick={cheat.solana}>Read it from Solana</button>
                <button onClick={cheat.impersonate} disabled={!trading}>Trade as someone else</button>
                <button onClick={cheat.verify} disabled={!settled}>Verify this round's draw</button>
                <button onClick={cheat.ledger}>Solana record</button>
              </div>
              {proof.map((l, k) => (
                <div key={proof.length - k} className={`line ${l.ok ? "ok" : "bad"}`}>{l.ok ? "✓" : "✗"} {l.text} {l.href && <a href={l.href} target="_blank" rel="noreferrer">Explorer</a>}</div>
              ))}
            </>
          )}
        </section>
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}

function Status({ t, now, seated }: { t: Table; now: number; seated: boolean }) {
  if (t.phase === 1) return <span className="status draw">MagicBlock VRF is drawing the insider…</span>;
  if (t.phase === 2) {
    const el = now - t.tStart.toNumber();
    if (el < ROUND_SECS) return <span className="status live">Trading</span>;
    if (el < ROUND_SECS + VOTE_SECS) return <span className="status vote">Trading closed. Accuse now: {Math.ceil(ROUND_SECS + VOTE_SECS - el)}s</span>;
    return <span className="status">Settling…</span>;
  }
  if (t.phase === 3) return <span className="status">Round over</span>;
  return <span className="status">{seated ? "Starting in a few seconds…" : "Waiting for players"}</span>;
}

function Clock({ elapsed }: { elapsed: number }) {
  const left = Math.max(0, ROUND_SECS - elapsed);
  return (
    <span className="clock">
      <span className="bar"><i style={{ width: `${(Math.min(elapsed, ROUND_SECS) / ROUND_SECS) * 100}%` }} /></span>
      <b>{left > 0 ? `${Math.ceil(left)}s` : "closed"}</b>
    </span>
  );
}
