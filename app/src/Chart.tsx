import { Shock } from "./chain";

export type Point = { t: number; p: number };
export type Mark = { t: number; p: number; seat: number; delta: number };

const W = 720, H = 300, L = 8, R = 56, T = 14, B = 22;

/// Price over the 60-second round, with every trade and every news shock marked.
export function Chart({ points, marks, shocks, future, elapsed, open, colors }: {
  points: Point[]; marks: Mark[]; shocks: Shock[]; future: Shock[]; elapsed: number; open: number; colors: string[];
}) {
  const all = [...points.map((p) => p.p), ...marks.map((m) => m.p), open].filter((v) => v > 0);
  const mid = all.length ? (Math.max(...all) + Math.min(...all)) / 2 : 1;
  const half = Math.max(all.length ? (Math.max(...all) - Math.min(...all)) / 2 : 0, mid * 0.006) * 1.25;
  const x = (t: number) => L + (t / 60) * (W - L - R);
  const y = (p: number) => T + (1 - (p - (mid - half)) / (2 * half)) * (H - T - B);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const label = (s: Shock) => `${s.bps > 0 ? "+" : "−"}${(Math.abs(s.bps) / 100).toFixed(1)}%`;

  return (
    <svg className="chartsvg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Price chart for this round">
      {[0, 15, 30, 45, 60].map((s) => (
        <g key={s}><line x1={x(s)} x2={x(s)} y1={T} y2={H - B} className="gridline" /><text x={x(s)} y={H - 6} className="axis" textAnchor="middle">{s}s</text></g>
      ))}
      {[-1, 0, 1].map((k) => {
        const p = mid + k * half * 0.8;
        return <g key={k}><line x1={L} x2={W - R} y1={y(p)} y2={y(p)} className="gridline" /><text x={W - R + 6} y={y(p) + 4} className="axis">{(p / 1e8).toFixed(2)}</text></g>;
      })}
      {open > 0 && <line x1={L} x2={W - R} y1={y(open)} y2={y(open)} className="openline" />}
      {shocks.map((s, i) => (
        <g key={`s${i}`}><line x1={x(s.at)} x2={x(s.at)} y1={T} y2={H - B} className={`shock ${s.bps > 0 ? "upl" : "downl"}`} />
          <text x={x(s.at) + 4} y={T + 10 + (i % 2) * 13} className={`shocklabel ${s.bps > 0 ? "upt" : "downt"}`}>News {label(s)}</text></g>
      ))}
      {future.map((s, i) => (
        <g key={`f${i}`}><line x1={x(s.at)} x2={x(s.at)} y1={T} y2={H - B} className="future" />
          <text x={Math.min(x(s.at) + 4, W - R - 150)} y={T + 40 + i * 13} className="futurelabel">{label(s)} (only you see this)</text></g>
      ))}
      {path && <path d={path} className="priceline" />}
      {marks.map((m, i) => {
        const cx = x(m.t), cy = y(m.p), up = m.delta > 0, d = 5 + Math.min(Math.abs(m.delta), 3);
        return <path key={i} d={up ? `M${cx},${cy - d} l${d},${d * 1.6} h${-2 * d} z` : `M${cx},${cy + d} l${d},${-d * 1.6} h${-2 * d} z`} fill={colors[m.seat]} className="mark" />;
      })}
      {last && <circle cx={x(last.t)} cy={y(last.p)} r="4" className="head" />}
      {elapsed > 0 && elapsed < 60 && <line x1={x(elapsed)} x2={x(elapsed)} y1={T} y2={H - B} className="nowline" />}
      {!points.length && <text x={(W - R) / 2} y={H / 2} textAnchor="middle" className="empty">The chart starts when the round does</text>}
    </svg>
  );
}
