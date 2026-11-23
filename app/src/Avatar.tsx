export const SEAT_NAMES = ["Bull", "Bear", "Fox", "Owl", "Wolf", "Cat"];
export const SEAT_COLORS = ["#ff6b6b", "#f5b83d", "#ff9f5a", "#3dd6c6", "#5aa9ff", "#b48cff"];
const LIGHT = ["#ffd0d0", "#ffe7b0", "#ffe0c4", "#c9f5ef", "#d3e7ff", "#e6d9ff"];

/// One trader per seat. `masked` puts the insider's mask on at the reveal.
export function Avatar({ seat, size = 84, empty, masked, mood = 0, dim }: { seat: number; size?: number; empty?: boolean; masked?: boolean; mood?: number; dim?: boolean }) {
  const c = empty ? "#2a3349" : SEAT_COLORS[seat], l = empty ? "#39445e" : LIGHT[seat];
  const ears = [
    <g key="e"><path d="M22 34 Q4 30 10 12 Q16 26 30 26Z" fill="#f4ead8" /><path d="M78 34 Q96 30 90 12 Q84 26 70 26Z" fill="#f4ead8" /></g>,
    <g key="e"><circle cx="24" cy="26" r="12" fill={c} /><circle cx="76" cy="26" r="12" fill={c} /><circle cx="24" cy="26" r="6" fill={l} /><circle cx="76" cy="26" r="6" fill={l} /></g>,
    <g key="e"><path d="M16 40 L20 6 L44 28Z" fill={c} /><path d="M84 40 L80 6 L56 28Z" fill={c} /><path d="M22 30 L23 14 L35 26Z" fill={l} /><path d="M78 30 L77 14 L65 26Z" fill={l} /></g>,
    <g key="e"><path d="M24 30 L18 8 L40 24Z" fill={c} /><path d="M76 30 L82 8 L60 24Z" fill={c} /></g>,
    <g key="e"><path d="M14 44 L14 4 L42 26Z" fill={c} /><path d="M86 44 L86 4 L58 26Z" fill={c} /></g>,
    <g key="e"><path d="M18 38 L24 8 L46 26Z" fill={c} /><path d="M82 38 L76 8 L54 26Z" fill={c} /><path d="M24 28 L27 16 L36 25Z" fill={l} /><path d="M76 28 L73 16 L64 25Z" fill={l} /></g>,
  ][seat];
  const owl = seat === 3;
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={`avatar ${dim ? "dim" : ""}`} aria-hidden="true">
      {ears}
      <circle cx="50" cy="56" r="34" fill={c} />
      <ellipse cx="50" cy="68" rx={owl ? 9 : 20} ry={owl ? 8 : 15} fill={l} />
      {!empty && (
        <>
          {masked && <path d="M14 48 Q50 34 86 48 Q86 62 68 62 Q58 62 50 54 Q42 62 32 62 Q14 62 14 48Z" fill="#0b0e14" />}
          <circle cx="37" cy="50" r={owl ? 10 : 7} fill="#fff" /><circle cx="63" cy="50" r={owl ? 10 : 7} fill="#fff" />
          <circle cx="38" cy="51" r="3.6" fill="#0b0e14" /><circle cx="62" cy="51" r="3.6" fill="#0b0e14" />
          {owl ? <path d="M45 62 L55 62 L50 71Z" fill="#f5b83d" /> : <ellipse cx="50" cy="62" rx="5" ry="3.6" fill="#0b0e14" />}
          {!owl && <path d={mood > 0 ? "M41 71 Q50 80 59 71" : mood < 0 ? "M41 77 Q50 69 59 77" : "M42 74 L58 74"} stroke="#0b0e14" strokeWidth="2.6" fill="none" strokeLinecap="round" />}
        </>
      )}
    </svg>
  );
}
