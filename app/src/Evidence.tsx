import type { ReactNode } from "react";
import type { Mark } from "./Chart";
import { ZERO, type Seat, type Shock } from "./chain";
import { Icon } from "./Icon";
import { Avatar } from "./Avatar";
import "./css/evidence.css";

const chips = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(0)}`;

export type EvidenceSlot = {
  net: number;
  status: "right" | "wrong" | "none";
  star: boolean;
};

/// Summarizes each seat's net trade in the 9 s before each revealed shock.
export function seatEvidence(
  marks: Mark[],
  shocks: Shock[],
  rumours: Record<number, number>,
  seatIdx: number,
): EvidenceSlot[] {
  return Array.from({ length: 4 }, (_, i) => {
    const sh = shocks[i];
    if (!sh || sh.at <= 0 || Math.abs(sh.bps) <= 1) {
      return { net: 0, status: "none", star: false };
    }
    let net = 0;
    for (const m of marks) {
      if (m.seat !== seatIdx) continue;
      const lead = sh.at - m.t;
      if (lead > 0 && lead <= 9) net += m.delta;
    }
    if (net === 0) return { net: 0, status: "none", star: false };
    const right = Math.sign(net) === Math.sign(sh.bps);
    const rDir = rumours[i];
    const star = right && rDir !== undefined && rDir !== 0 && Math.sign(net) !== rDir;
    return { net, status: right ? "right" : "wrong", star };
  });
}

/// Counts how many revealed shocks had a net pre-shock trade on the right side.
export function tellCount(
  marks: Mark[],
  shocks: Shock[],
  rumours: Record<number, number>,
  seatIdx: number,
): number {
  return seatEvidence(marks, shocks, rumours, seatIdx).filter((x) => x.status === "right").length;
}

type Props = {
  seats: Seat[];
  eq: number[];
  marks: Mark[];
  shocks: Shock[];
  rumours: Record<number, number>;
  seatNames: readonly string[];
  seatColors: readonly string[];
  voting: boolean;
  mySeat: number;
  canVote: boolean;
  myVote: number | null;
  locked: boolean;
  busy: boolean;
  allIn: boolean;
  onAllInChange: (next: boolean) => void;
  onAccuse: (seatIdx: number) => void;
  spectateNote?: ReactNode;
};

export function Evidence({
  seats,
  eq,
  marks,
  shocks,
  rumours,
  seatNames,
  seatColors,
  voting,
  mySeat,
  canVote,
  myVote,
  locked,
  busy,
  allIn,
  onAllInChange,
  onAccuse,
  spectateNote,
}: Props) {
  const isZero = (s: Seat) => s.player.equals(ZERO);
  const showToggle = voting && mySeat >= 0;

  return (
    <div className={`ballot ${voting && mySeat >= 0 && canVote && !locked ? "open" : ""} ${voting && locked ? "locked" : ""}`}>
      {spectateNote}
      {voting && (
        <div className="ev-bar">
          <p className="ev-legend">Trades in the 9 s before each shock. Green = right side. Star = defied a false rumour.</p>
          {showToggle && (
            <label className={`ev-allin ${allIn ? "on" : ""} ${locked || !canVote || busy ? "disabled" : ""}`}>
              <input
                type="checkbox"
                role="switch"
                aria-checked={allIn}
                checked={allIn}
                disabled={locked || !canVote || busy}
                onChange={(e) => onAllInChange(e.target.checked)}
                {...({ switch: "" } as any)}
              />
              <span>All in: right +200, wrong −150</span>
            </label>
          )}
        </div>
      )}
      <div className="suspects">
        {seats.map((s, i) => {
          const empty = isZero(s);
          const mine = i === mySeat;
          const picked = voting && myVote === i;
          const can = voting && mySeat >= 0 && canVote && !mine && !empty && !locked;
          const showAct = voting && mySeat >= 0 && !mine && !empty && (canVote || picked);
          const slots = !empty && voting ? seatEvidence(marks, shocks, rumours, i) : [];
          const rightCount = slots.filter((x) => x.status === "right").length;
          return (
            <button
              key={i}
              type="button"
              className={`suspect ${picked ? "picked" : ""} ${mine ? "self" : ""} ${voting && locked && !picked ? "dim" : ""}`}
              style={{ ["--c" as any]: seatColors[i] }}
              disabled={!can || busy}
              onClick={() => onAccuse(i)}
            >
              <Avatar seat={i} size={38} empty={empty} />
              <span className="s-name">{seatNames[i]}{mine && <em>You</em>}</span>
              <span className={`s-pnl num ${eq[i] >= 0 ? "up" : "down"}`}>{empty ? "–" : chips(eq[i])}</span>
              {picked && <span className="s-stamp"><Icon name="gavel" size={13} />Accused</span>}
              <span className="s-meta">{empty ? "empty" : `${s.trades} ${s.trades === 1 ? "trade" : "trades"}`}</span>
              {voting && !empty && (
                <div className="ev-wrap">
                  <div className="ev-slots" aria-label={`${rightCount} of 4 right`}>
                    {slots.map((slot, idx) => (
                      <span
                        key={idx}
                        className={`ev-slot ${slot.status}`}
                        title={`Shock ${idx + 1}: ${slot.net > 0 ? `net buy ${slot.net}` : slot.net < 0 ? `net sell ${-slot.net}` : "no trade"}${slot.star ? " · defied false rumour" : ""}`}
                      >
                        {slot.net > 0 ? `▲${slot.net}` : slot.net < 0 ? `▼${-slot.net}` : "–"}
                        {slot.star && <span className="ev-star" aria-label="defied false rumour">★</span>}
                      </span>
                    ))}
                  </div>
                  <span className="ev-count">{rightCount} of 4 right</span>
                </div>
              )}
              {showAct && <span className="s-act">{picked ? "ACCUSED" : allIn ? "All-in" : "Accuse"}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
