import { useEffect, useMemo, useState } from "react";
import { FIRST_TABLE, PID, ROUND_SECS, SEATS, Session, TABLES, Table, ZERO, explorer, fetchTable, guestKey, openSession, short, tablePda } from "./chain";
import { Avatar, SEAT_COLORS, SEAT_NAMES } from "./Avatar";
import { TableView } from "./Table";


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
          <li><b>Accuse</b><span>Cast a sealed vote. Right: +100 chips and a share of their profit. Wrong: −50.</span></li>
        </ol>
      </section>
      <section className="tables">
        {Array.from({ length: TABLES }, (_, i) => {
          const t = tables[i];
          const seated = t ? t.seats.filter((s) => !s.player.equals(ZERO)).length : 0;
          return (
            <button key={i} className="tablecard" onClick={() => onOpen(i)} disabled={!t}>
              <div className="row"><b>Table {i + 1}</b><span className={`dot ${t?.phase === 2 ? "on" : ""}`} /></div>
              <div className="minis">{Array.from({ length: SEATS }, (_, k) => <Avatar key={k} seat={k} size={30} empty={!t || t.seats[k].player.equals(ZERO)} />)}</div>
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

