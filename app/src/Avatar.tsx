export const SEAT_NAMES = ["Ruby", "Amber", "Rusty", "Jade", "Azure", "Violet"];
export const SEAT_COLORS = ["#ff5c6c", "#f5b83d", "#ff8a3d", "#3dd6c6", "#5aa9ff", "#b48cff"];

/// A robot-head badge in the seat's colour, for name tags, ballots, the tape and the lobby.
export function Avatar({ seat, size = 84, empty, masked }: { seat: number; size?: number; empty?: boolean; masked?: boolean; mood?: number; dim?: boolean }) {
  const c = empty ? "#2b3157" : masked ? "#15171c" : SEAT_COLORS[seat];
  const eye = masked ? "#ff3b3b" : "#fff";
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className="avatar" aria-hidden="true">
      <rect x="46" y="8" width="8" height="16" rx="4" fill={c} /><circle cx="50" cy="9" r="7.5" fill={empty ? c : masked ? "#ff3b3b" : "#fff"} />
      <rect x="4" y="42" width="14" height="24" rx="6" fill={c} /><rect x="82" y="42" width="14" height="24" rx="6" fill={c} />
      <rect x="12" y="22" width="76" height="66" rx="20" fill={c} />
      <rect x="12" y="62" width="76" height="26" rx="13" fill="#000" opacity=".18" />
      <rect x="22" y="36" width="56" height="28" rx="14" fill="#0a0c1f" />
      {!empty && <><rect x="31" y="43" width="12" height="14" rx="6" fill={eye} /><rect x="57" y="43" width="12" height="14" rx="6" fill={eye} /></>}
      {!empty && <rect x="40" y="73" width="20" height="5" rx="2.5" fill="#0a0c1f" opacity=".55" />}
    </svg>
  );
}
