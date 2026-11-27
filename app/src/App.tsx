import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { FIRST_TABLE, PID, ROUND_SECS, SEATS, Session, TABLES, Table, TEE_VALIDATOR, VOTE_SECS, ZERO, base, equity, explorer, fetchTable, guestKey, openSession, playerPda, short, tablePda } from "./chain";
import { Avatar, SEAT_COLORS } from "./Avatar";
import { Icon, Logo } from "./Icon";
import { Scene3D } from "./Scene3D";
import { TableView } from "./Table";
import { Leaderboard } from "./Leaderboard";

const WALLET_TITLE = "Optional. Your season record follows your wallet. Moves still need no pop-ups.";

async function walletSessionKey(
  wallet: PublicKey,
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<Keypair> {
  if (!signMessage) throw new Error("This wallet can't sign messages; play as guest");
  const cacheKey = `tipoff-wallet-session:${wallet.toBase58()}`;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(cached)));
  } catch {
    try { localStorage.removeItem(cacheKey); } catch {}
  }
  const message = new TextEncoder().encode(`Tipoff session key v1\n${wallet.toBase58()}`);
  const signature = await signMessage(message);
  const signatureBuffer = new ArrayBuffer(signature.byteLength);
  new Uint8Array(signatureBuffer).set(signature);
  const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", signatureBuffer));
  const kp = Keypair.fromSeed(seed);
  try { localStorage.setItem(cacheKey, JSON.stringify([...kp.secretKey])); } catch {}
  return kp;
}

async function prepareWalletProfile(
  wallet: PublicKey,
  sessionKey: Keypair,
  session: Session,
  sendWalletTransaction: (tx: Transaction, connection: Connection) => Promise<string>,
): Promise<string | null> {
  const player = playerPda(wallet);
  const info = await base.getAccountInfo(player, "confirmed");
  const delegated = !!info && info.owner.equals(DELEGATION_PROGRAM_ID);
  let playerAccount: any = null;

  if (info) {
    if (!info.owner.equals(PID) && !delegated) throw new Error("Could not read this wallet's profile on devnet");
    try {
      playerAccount = session.program.coder.accounts.decode("player", info.data);
    } catch {
      if (delegated) playerAccount = await (session.program.account as any).player.fetch(player);
      else throw new Error("Could not read this wallet's profile on devnet");
    }
    if (!playerAccount.session.equals(sessionKey.publicKey))
      throw new Error("This wallet's profile uses a different session key");
  }

  if (delegated) return null;
  if ((await base.getBalance(wallet, "confirmed")) < 0.01 * LAMPORTS_PER_SOL) {
    try {
      const airdrop = await base.requestAirdrop(wallet, 0.5 * LAMPORTS_PER_SOL);
      await base.confirmTransaction(airdrop, "confirmed");
    } catch {
      throw new Error("You need a little devnet SOL for a one-time profile");
    }
  }

  const tx = new Transaction();
  if (!info) {
    tx.add(await session.program.methods.initPlayer(sessionKey.publicKey)
      .accountsPartial({ player, wallet }).instruction());
  }
  tx.add(await session.program.methods.delegatePlayer()
    .accountsPartial({ payer: wallet, wallet, pda: player, validator: TEE_VALIDATOR }).instruction());
  const signature = await sendWalletTransaction(tx, base);
  const confirmation = await base.confirmTransaction(signature, "confirmed");
  if (confirmation.value.err) throw new Error("The wallet profile transaction failed to confirm");
  return signature;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [walletNotice, setWalletNotice] = useState("");
  const [walletBusy, setWalletBusy] = useState(false);
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const sessionRef = useRef<Session | null>(null);
  const setActiveSession = useCallback((next: Session) => {
    sessionRef.current = next;
    setSession(next);
  }, []);
  const [open, setOpenState] = useState<number | null>(() => {
    const n = Number(location.hash.slice(1)) - 1;
    return location.hash.length > 1 && n >= 0 && n < TABLES ? n : null;
  });
  const [autoSit, setAutoSit] = useState(false);
  const setOpen = (i: number | null, auto = false) => {
    setAutoSit(i !== null && auto);
    history.replaceState(null, "", i === null ? location.pathname : `#${i + 1}`);
    setOpenState(i);
  };
  const [lat, setLat] = useState<number[]>([]);

  useEffect(() => {
    let live = true;
    openSession(guestKey()).then((next) => {
      if (live) setActiveSession(next);
    }).catch((e) => {
      if (live) setError(String(e?.message ?? e));
    });
    return () => { live = false; };
  }, [setActiveSession]);

  useEffect(() => {
    let live = true;
    if (open !== null) return () => { live = false; };
    if (!wallet.publicKey) {
      if (sessionRef.current?.player) {
        openSession(guestKey()).then((next) => { if (live) setActiveSession(next); }).catch(() => {});
      }
      return () => { live = false; };
    }
    setWalletNotice("");
    setWalletBusy(true);
    (async () => {
      try {
        const kp = await walletSessionKey(wallet.publicKey!, wallet.signMessage);
        if (!live) return;
        const next = await openSession(kp, wallet.publicKey!);
        const signature = await prepareWalletProfile(wallet.publicKey!, kp, next, wallet.sendTransaction);
        if (!live) return;
        if (signature) console.info("Wallet profile transaction confirmed", signature);
        setActiveSession(next);
      } catch (e) {
        if (!live) return;
        const message = String((e as any)?.message ?? e);
        setWalletNotice(message);
        openSession(guestKey()).then((next) => { if (live) setActiveSession(next); }).catch(() => {});
      } finally {
        if (live) setWalletBusy(false);
      }
    })();
    return () => { live = false; };
  }, [open, wallet.publicKey, wallet.signMessage, wallet.sendTransaction, setActiveSession]);

  const onWalletClick = () => {
    if (wallet.publicKey) {
      wallet.disconnect().catch((e) => setWalletNotice(String((e as any)?.message ?? e)));
    } else {
      setVisible(true);
    }
  };
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
        ? <Lobby
            session={session}
            onOpen={(i) => setOpen(i, false)}
            onPlay={(i) => setOpen(i, true)}
            walletConnected={!!wallet.publicKey}
            walletBusy={walletBusy}
            walletNotice={walletNotice}
            onWalletClick={onWalletClick}
          />
        : <TableView key={open} session={session} index={open} autoSit={autoSit} median={median} onLeave={() => setOpen(null, false)} onLatency={(ms) => setLat((l) => [...l.slice(-19), ms])} />}
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

function Lobby({ session, onOpen, onPlay, walletConnected, walletBusy, walletNotice, onWalletClick }: {
  session: Session;
  onOpen: (i: number) => void;
  onPlay: (i: number) => void;
  walletConnected: boolean;
  walletBusy: boolean;
  walletNotice: string;
  onWalletClick: () => void;
}) {
  const [tables, setTables] = useState<(Table | null)[]>([]);
  const [now, setNow] = useState(Date.now() / 1000);
  const [copied, setCopied] = useState<number | null>(null);
  const [copyTick, setCopyTick] = useState(0);
  const copyTimer = useRef<number | undefined>(undefined);
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
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const loading = tables.length === 0 || tables.every((t) => !t);
  const quick = tables.findIndex(joinable);
  const liveIdx = tables.findIndex((t) => t?.phase === 2 && t.tStart.toNumber() + ROUND_SECS > now);
  const soonestIdx = tables.reduce((best, t, i) => {
    if (!t || t.phase !== 2) return best;
    const end = t.tStart.toNumber() + ROUND_SECS + VOTE_SECS;
    if (best < 0) return i;
    const bestEnd = tables[best]!.tStart.toNumber() + ROUND_SECS + VOTE_SECS;
    return end < bestEnd ? i : best;
  }, -1);
  const playIdx = quick >= 0 ? quick : soonestIdx >= 0 ? soonestIdx : Math.max(0, liveIdx);
  const allMidRound = !loading && quick < 0 && tables.some((t) => t?.phase === 2 || t?.phase === 1);
  const soonestLeft = soonestIdx >= 0 ? Math.max(1, Math.ceil(tables[soonestIdx]!.tStart.toNumber() + ROUND_SECS + VOTE_SECS - now)) : 0;

  const copyFriendLink = async (i: number) => {
    const link = new URL(`#${i + 1}`, location.href).href;
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      try {
        const field = Object.assign(document.createElement("textarea"), { value: link });
        field.setAttribute("readonly", "");
        field.style.cssText = "position:fixed;top:0;opacity:0";
        document.body.append(field);
        field.select();
        document.execCommand("copy");
        field.remove();
      } catch {}
    }
    clearTimeout(copyTimer.current);
    setCopied(i);
    setCopyTick((n) => n + 1);
    copyTimer.current = window.setTimeout(() => setCopied(null), 2400);
  };

  return (
    <main className="lobby">
      <Backdrop tables={tables} featured={liveIdx} now={now} />
      <div className="lobby-shade" />

      <header className="lobby-top">
        <div className="brand"><Logo size={30} /><span className="wordmark">Tipoff</span></div>
        <span className="grow" />
        <span className="pill" title="A key made in this browser signs your moves. No wallet, no fees."><i className="dot on" />{session.player ? "Wallet" : "Guest"} {short(session.id)}</span>
        <button className="wallet-connect" type="button" title={WALLET_TITLE} disabled={walletBusy} onClick={onWalletClick}>
          <span className="wallet-label-wide">{walletBusy ? "Connecting…" : walletConnected ? "Disconnect" : "Connect wallet"}</span>
          <span className="wallet-label-short">{walletBusy ? "…" : walletConnected ? "Disconnect" : "Connect"}</span>
        </button>
      </header>
      {walletNotice && <p className="wallet-notice" role="status">
        {walletNotice}
        {walletNotice.startsWith("You need a little devnet SOL") && <> <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">Solana faucet</a></>}
      </p>}

      <section className="pitch">
        <h1>Someone on this floor already knows the news.</h1>
        <p>A 60-second trading game where one of six players secretly knows the news, and only a private rollup can keep that secret.</p>
        <div className="cta">
          <button type="button" className="btn gold big" disabled={loading} onClick={() => onPlay(playIdx)}>
            {loading ? (
              <><span className="spinner" aria-hidden="true" />Play now</>
            ) : allMidRound ? (
              <><Icon name="eye" size={22} />{soonestLeft > 0 ? `Watch live, seat opens in ${soonestLeft}s` : "Watch live"}</>
            ) : (
              <><Icon name="play" size={22} />Play now</>
            )}
          </button>
          <span className="cta-note">No wallet. No fees. Bots fill empty seats.</span>
        </div>
        <ul className="pitch-proof" aria-label="Security proof">
          <li><Icon name="lock" size={14} /><span>Insider picked by MagicBlock VRF inside a private rollup</span></li>
          <li><Icon name="shield" size={14} /><a href="https://github.com/dren712/tipoff/blob/main/docs/ATTACKS.md" target="_blank" rel="noreferrer">11 of 11 live cheat attempts rejected</a></li>
          <li><Icon name="bolt" size={14} /><span>No wallet, no fees, about half a second per move</span></li>
        </ul>
        <p className="pitch-built">Built on <b>Solana</b> · <b>MagicBlock Private Ephemeral Rollup</b></p>
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
              <div key={i} className="room-slot">
                <button type="button" className={`room ${st?.kind ?? "loading"}`} onClick={() => onOpen(i)} disabled={!t}>
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
                {play && (
                  <div className="room-actions">
                    <button type="button" className={`room-share ${copied === i ? "copied" : ""}`} onClick={() => copyFriendLink(i)}>
                      <Icon name={copied === i ? "check" : "link"} size={13} />
                      <span>{copied === i ? "Link copied" : "Play with friends"}</span>
                    </button>
                    <span className="room-copy-sr" role="status">
                      {copied === i ? `Link copied${copyTick % 2 ? "\u00A0" : ""}` : ""}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
          <div className="room room-locked" aria-disabled="true">
            <span className="room-no" aria-hidden="true"><Icon name="lock" size={24} /></span>
            <span className="room-main">
              <span className="room-head"><b>SOL tables</b><span className="room-badge">Coming with mainnet</span></span>
              <span className="room-description">Ante SOL, and the pot pays out on-chain at settlement.</span>
            </span>
          </div>
        </div>
        <p className="fineprint">Play chips only, no real money. Runs on Solana devnet inside a MagicBlock private rollup. Program <a href={explorer("address", PID.toBase58())} target="_blank" rel="noreferrer">{short(PID)}</a></p>
      </section>

      <Leaderboard session={session} />
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
