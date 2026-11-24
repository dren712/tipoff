import { useEffect, useMemo, useRef, useState } from "react";
import { FIRST_TABLE, PID, ROUND_SECS, SEATS, Session, TABLES, Table, ZERO, equity, explorer, fetchTable, guestKey, openSession, short, tablePda } from "./chain";
import { Avatar, SEAT_COLORS } from "./Avatar";
import { Icon, Logo } from "./Icon";
import { Scene3D } from "./Scene3D";
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

  if (error) return (
    <div className="app boot">
      <div className="bootcard">
        <Logo size={56} />
        <h1 className="wordmark">Tipoff</h1>
        <p className="bad">Could not reach the rollup.</p>
        <p className="muted small">{error}</p>
        <button className="btn gold" onClick={() => location.reload()}>Try again</button>
      </div>
    </div>
  );
  if (!session) return (
    <div className="app boot">
      <div className="bootcard">
        <Logo size={56} />
        <h1 className="wordmark">Tipoff</h1>
        <div className="loader"><i /></div>
        <p className="muted">Signing in to the private rollup</p>
      </div>
    </div>
  );
  return (
    <div className="app">
      {open === null
        ? <Lobby session={session} onOpen={setOpen} />
        : <TableView key={open} session={session} index={open} median={median} onLeave={() => setOpen(null)} onLatency={(ms) => setLat((l) => [...l.slice(-19), ms])} />}
    </div>
  );
}

type Status = { label: string; kind: "open" | "live" | "vote" | "wait"; left: number };
function status(t: Table, now: number): Status {
  if (t.phase === 1) return { label: "Dealing roles", kind: "wait", left: 0 };
  if (t.phase === 2) {
    const left = t.tStart.toNumber() + ROUND_SECS - now;
    return left > 0 ? { label: "Trading", kind: "live", left: Math.ceil(left) } : { label: "Voting", kind: "vote", left: 0 };
  }
  return t.seats.some((s) => !s.player.equals(ZERO)) ? { label: "Starting soon", kind: "wait", left: 0 } : { label: "Open", kind: "open", left: 0 };
}
const joinable = (t: Table | null | undefined) => !!t && (t.phase === 0 || t.phase === 3) && t.seats.some((s) => s.player.equals(ZERO));

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

  const quick = tables.findIndex(joinable);
  const liveIdx = tables.findIndex((t) => t?.phase === 2 && t.tStart.toNumber() + ROUND_SECS > now);

  return (
    <main className="lobby">
      <Backdrop tables={tables} featured={liveIdx} now={now} />
      <div className="lobby-shade" />

      <header className="lobby-top">
        <div className="brand"><Logo size={30} /><span className="wordmark">Tipoff</span></div>
        <span className="grow" />
        <span className="pill" title="A key made in this browser signs your moves. No wallet, no fees."><i className="dot on" />Guest {short(session.kp.publicKey)}</span>
      </header>

      <section className="pitch">
        <h1>Someone on this floor already knows the news.</h1>
        <p>Six traders. One live SOL price. Sixty seconds. One of you is secretly tipped off before every shock. Trade, then vote out the insider.</p>
        <div className="cta">
          <button className="btn gold big" disabled={!tables.length} onClick={() => onOpen(quick >= 0 ? quick : Math.max(0, liveIdx))}>
            <Icon name="play" size={22} />{quick >= 0 ? "Play now" : "Watch a round"}
          </button>
          <span className="muted small">No wallet. No fees. Bots fill empty seats.</span>
        </div>
      </section>

      <section className="rooms" aria-label="Tables">
        <ol className="how">
          <li><Icon name="bolt" /><b>Trade</b><span>60 seconds, one tap per lot</span></li>
          <li><Icon name="eye" /><b>Watch</b><span>Who moved before the news?</span></li>
          <li><Icon name="gavel" /><b>Accuse</b><span>Right +100. Wrong −50.</span></li>
        </ol>
        <div className="roomrow">
          {Array.from({ length: TABLES }, (_, i) => {
            const t = tables[i];
            const seated = t ? t.seats.filter((s) => !s.player.equals(ZERO)).length : 0;
            const st = t ? status(t, now) : null;
            const play = joinable(t);
            return (
              <button key={i} className={`room ${st?.kind ?? "loading"}`} onClick={() => onOpen(i)} disabled={!t}>
                <span className="room-no">{i + 1}</span>
                <span className="room-main">
                  <span className="room-head"><b>Table {i + 1}</b><span className="muted">Round {t ? t.round.toString() : "–"}</span></span>
                  <span className="minis">{Array.from({ length: SEATS }, (_, k) => <Avatar key={k} seat={k} size={26} empty={!t || t.seats[k].player.equals(ZERO)} />)}</span>
                  <span className="room-state">
                    <i className={`dot ${st?.kind === "live" ? "on" : st?.kind === "vote" ? "hot" : ""}`} />
                    {st ? st.label : "Loading"}{st?.kind === "live" && <em>{st.left}s</em>}
                    <span className="muted">{seated}/{SEATS}</span>
                  </span>
                </span>
                <span className={`room-go ${play ? "play" : ""}`}>{play ? "Play" : "Watch"}</span>
              </button>
            );
          })}
        </div>
        <p className="fineprint">Play chips only, no real money. Runs on Solana devnet inside a MagicBlock private rollup. Program <a href={explorer("address", PID.toBase58())} target="_blank" rel="noreferrer">{short(PID)}</a></p>
      </section>
    </main>
  );
}

/// The trading floor behind the lobby, showing whichever table is live right now.
function Backdrop({ tables, featured, now }: { tables: (Table | null)[]; featured: number; now: number }) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene3D | null>(null);
  const hist = useRef<{ id: string; points: { t: number; p: number }[] }>({ id: "", points: [] });
  useEffect(() => {
    if (!host.current) return;
    const s = (scene.current = new Scene3D(host.current, SEAT_COLORS, () => [], () => {}));
    s.orbit = true;
    return () => { s.dispose(); scene.current = null; };
  }, []);
  useEffect(() => {
    const t = featured >= 0 ? tables[featured] : null;
    if (!scene.current) return;
    if (!t) {
      scene.current.set({
        stage: "idle", me: -1, insiderMe: false, insider: 255, caught: false,
        seats: Array.from({ length: SEATS }, () => ({ empty: false, pos: 0, mood: 0 })),
        wall: { price: 0, open: 0, elapsed: 0, round: 0, points: [], marks: [], shocks: [], future: [], title: "MARKET OPENS SOON", sub: "Take a seat and the bell rings" },
      });
      return;
    }
    const id = `${featured}:${t.round.toString()}`, price = t.price.toNumber(), open = t.openPrice.toNumber();
    const elapsed = Math.min(ROUND_SECS, now - t.tStart.toNumber());
    if (hist.current.id !== id) hist.current = { id, points: [] };
    hist.current.points.push({ t: elapsed, p: price });
    scene.current.set({
      stage: "live", me: -1, insiderMe: false, insider: 255, caught: false,
      seats: t.seats.map((s) => ({ empty: s.player.equals(ZERO), pos: s.pos, mood: Math.sign(Math.round(equity(s, price, open))) })),
      wall: { price, open, elapsed, round: Number(t.round.toString()), points: hist.current.points, marks: [], shocks: t.shocks.filter((s) => s.bps !== 0), future: [], title: "", sub: "" },
    });
  }, [tables, featured, now]);
  return <div className="backdrop" ref={host} aria-hidden="true" />;
}
