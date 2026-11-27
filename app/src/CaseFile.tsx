import { NONE, type Shock } from "./chain";
import type { Mark } from "./Chart";
import { seatEvidence, tellCount } from "./Evidence";
import { Icon } from "./Icon";
import "./css/casefile.css";

type SnapSeat = {
  seat: number;
  name: string;
  played: boolean;
  suspect: number;
};

type CaseSnap = {
  insider: number;
  caught: boolean;
  mySeat: number;
  accusers: number;
  seats: SnapSeat[];
};

const pct = (bps: number) => `${bps > 0 ? "+" : "−"}${(Math.abs(bps) / 100).toFixed(1)}%`;

/// Post-round breakdown showing how the insider traded ahead of each shock.
export function CaseFile({
  snap,
  marks,
  shocks,
  rumours,
  names,
  colors,
}: {
  snap: CaseSnap;
  marks: Mark[];
  shocks: Shock[];
  rumours: Record<number, number>;
  names: readonly string[];
  colors: readonly string[];
}) {
  if (marks.length === 0) return null;

  const I = snap.insider;
  const insiderName = names[I];
  const slots = seatEvidence(marks, shocks, rumours, I);
  const k = tellCount(marks, shocks, rumours, I);

  const headline = snap.caught
    ? `The tell: ${insiderName} was on the right side before ${k} of 4 shocks.`
    : k >= 2
      ? `The tell was there: ${insiderName} was on the right side before ${k} of 4 shocks.`
      : `${insiderName} hid it well: right side before only ${k} of 4 shocks.`;

  const shockRows: {
    key: number;
    status: "right" | "wrong" | "none";
    text: string;
  }[] = [];

  for (let i = 0; i < 4; i++) {
    const sh = shocks[i];
    if (!sh || sh.at <= 0 || Math.abs(sh.bps) <= 1) continue;
    const slot = slots[i];
    const qualifying = marks.filter((m) => m.seat === I && sh.at - m.t > 0 && sh.at - m.t <= 9);
    const prefix = `Shock ${i + 1} ${pct(sh.bps)} at ${sh.at}s`;
    let detail = `${prefix} · no trade`;
    if (slot.status === "right" && qualifying.length > 0 && slot.net !== 0) {
      const earliest = qualifying.reduce((min, m) => Math.min(min, m.t), qualifying[0].t);
      const lead = Math.round(sh.at - earliest);
      const absNet = Math.abs(slot.net);
      const verb = slot.net > 0 ? "bought" : "sold";
      const lotWord = absNet === 1 ? "lot" : "lots";
      detail = `${prefix} · ${insiderName} ${verb} ${absNet} ${lotWord} ${lead}s before${slot.star ? " against the rumour" : ""}`;
    } else if (slot.status === "wrong") {
      detail = `${prefix} · ${insiderName} traded the wrong way (decoy)`;
    }
    shockRows.push({ key: i, status: slot.status, text: detail });
  }

  let yourLine: string | null = null;
  if (snap.mySeat >= 0) {
    const mySnap = snap.seats[snap.mySeat];
    if (snap.mySeat === I) {
      const others = snap.seats.filter((s) => s.played && s.seat !== I).length;
      yourLine = `Your footprint: ${k} of 4 shocks traded early. ${snap.accusers} of ${others} rivals accused you.`;
    } else if (mySnap?.suspect === I) {
      yourLine = "You read it right.";
    } else if (mySnap && mySnap.suspect !== NONE) {
      const sTells = tellCount(marks, shocks, rumours, mySnap.suspect);
      yourLine = `You accused ${names[mySnap.suspect]}: right side before ${sTells} of 4. ${insiderName} had ${k}.`;
    } else {
      yourLine = `No vote. ${insiderName} had ${k} of 4 tells.`;
    }
  }

  return (
    <section className="casefile" aria-label="Case file">
      <div className="cf-head">
        <span className="cf-kicker">Case file</span>
        <b className="cf-title">{headline}</b>
      </div>
      {shockRows.length > 0 && (
        <ul className="cf-rows">
          {shockRows.map((row) => (
            <li key={row.key} className={`cf-row ${row.status}`}>
              <i className="cf-dot" style={{ background: colors[I] }} aria-hidden="true" />
              <span className={`cf-ic ${row.status}`} aria-hidden="true">
                {row.status === "right" ? <Icon name="check" size={12} /> : row.status === "wrong" ? <Icon name="close" size={12} /> : "–"}
              </span>
              <span className="cf-text">{row.text}</span>
            </li>
          ))}
        </ul>
      )}
      {yourLine && <p className="cf-you">{yourLine}</p>}
    </section>
  );
}
