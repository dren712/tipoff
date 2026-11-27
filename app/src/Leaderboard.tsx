import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { Board, BoardEntry, Session, ZERO, boardPda, explorer, fetchBoard } from "./chain";
import { rankTitle } from "./Career";
import { Icon } from "./Icon";
import "./css/lobby.css";

const ADJECTIVES = [
  "Swift", "Quiet", "Sharp", "Bold", "Cool", "Clever", "Lucky", "Keen",
  "Calm", "Sly", "Bright", "Crisp", "Stealth", "Silver", "Amber", "Ruby",
  "Jade", "Azure", "Iron", "Velvet", "Silent", "Quick", "Wily", "Brisk",
  "Golden", "Cobalt", "Nimble", "Steady", "Lucid", "Alert", "Prime", "Daring",
];
const ANIMALS = [
  "Fox", "Hawk", "Owl", "Lynx", "Wolf", "Otter", "Falcon", "Puma",
  "Raven", "Viper", "Badger", "Crane", "Mink", "Kestrel", "Heron", "Hare",
  "Finch", "Cobra", "Bison", "Orca", "Gecko", "Puffin", "Marten", "Stoat",
  "Tiger", "Shrike", "Jackal", "Ferret", "Condor", "Jay", "Wren", "Pike",
];

export function nicknameFor(player: PublicKey): string {
  const b = player.toBytes();
  return `${ADJECTIVES[b[0] % ADJECTIVES.length]} ${ANIMALS[b[1] % ANIMALS.length]}`;
}

const chips = (n: number) => {
  const v = Math.round(n);
  return v === 0 ? "0" : `${v > 0 ? "+" : "−"}${Math.abs(v)}`;
};

export function Leaderboard({ session }: { session: Session }) {
  const [board, setBoard] = useState<Board | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const b = await fetchBoard(session).catch(() => null);
      if (live) setBoard(b);
    };
    load();
    const id = setInterval(load, 5000);
    return () => { live = false; clearInterval(id); };
  }, [session]);

  const me = session.id;
  const sorted: BoardEntry[] = board
    ? board.entries
        .filter((e) => !e.player.equals(ZERO))
        .sort((a, b) => b.score.cmp(a.score) || b.caught - a.caught)
    : [];
  const top = sorted.slice(0, 10);
  const myIdx = sorted.findIndex((e) => e.player.equals(me));

  return (
    <section className="lb" aria-labelledby="lb-heading">
      <div className="lb-head">
        <h2 id="lb-heading">Season board, kept on Solana</h2>
        <div className="lb-head-right">
          {myIdx >= 0 && <span className="lb-mypos num">#{myIdx + 1} of {sorted.length}</span>}
          <a
            className="lb-link"
            href={explorer("address", boardPda().toBase58())}
            target="_blank"
            rel="noreferrer"
          >
            Explorer <Icon name="link" size={12} />
          </a>
        </div>
      </div>

      {top.length === 0 ? (
        <div className="lb-empty">
          <p>Be the first on the board</p>
        </div>
      ) : (
        <div className="lb-wrap" tabIndex={0} role="region" aria-labelledby="lb-heading">
          <table className="lb-table">
            <caption className="lb-sr">Top 10 players by season score</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Player</th>
                <th scope="col">Rank</th>
                <th scope="col">Score</th>
                <th scope="col">Caught</th>
                <th scope="col">Best</th>
              </tr>
            </thead>
            <tbody>
              {top.map((e, i) => {
                const isMe = e.player.equals(me);
                const sc = e.score.toNumber() / 1e6;
                const scRound = Math.round(sc);
                return (
                  <tr key={e.player.toBase58()} className={isMe ? "lb-row me" : "lb-row"}>
                    <th scope="row" className="num lb-pos">#{i + 1}</th>
                    <td className="lb-name">
                      <span>{nicknameFor(e.player)}</span>
                      {isMe && <em className="lb-you">You</em>}
                    </td>
                    <td className="lb-rank">{rankTitle(e.caught, e.escapes)}</td>
                    <td className={`num lb-score ${scRound > 0 ? "up" : scRound < 0 ? "down" : ""}`}>{chips(sc)}</td>
                    <td className="num lb-caught">{e.caught}</td>
                    <td className="num lb-best">{e.best}</td>
                  </tr>
                );
              })}
              {myIdx >= 10 && (() => {
                const e = sorted[myIdx];
                const sc = e.score.toNumber() / 1e6;
                const scRound = Math.round(sc);
                return (
                  <tr key={e.player.toBase58()} className="lb-row me pinned">
                    <th scope="row" className="num lb-pos">#{myIdx + 1}</th>
                    <td className="lb-name">
                      <span>{nicknameFor(e.player)}</span>
                      <em className="lb-you">You</em>
                    </td>
                    <td className="lb-rank">{rankTitle(e.caught, e.escapes)}</td>
                    <td className={`num lb-score ${scRound > 0 ? "up" : scRound < 0 ? "down" : ""}`}>{chips(sc)}</td>
                    <td className="num lb-caught">{e.caught}</td>
                    <td className="num lb-best">{e.best}</td>
                  </tr>
                );
              })()}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
