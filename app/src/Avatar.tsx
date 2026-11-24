export const SEAT_NAMES = ["Ruby", "Amber", "Rusty", "Jade", "Azure", "Violet"];
export const SEAT_COLORS = ["#ff5c6c", "#f5b83d", "#ff8a3d", "#3dd6c6", "#5aa9ff", "#b48cff"];

/// A small robot-head badge in the seat's colour, for lists and the lobby.
export function Avatar({ seat, size = 84, empty, masked }: { seat: number; size?: number; empty?: boolean; masked?: boolean; mood?: number; dim?: boolean }) {
  const c = empty ? "#2a3349" : masked ? "#15171c" : SEAT_COLORS[seat];
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className="avatar" aria-hidden="true">
      <rect x="46" y="6" width="8" height="16" rx="4" fill={c} /><circle cx="50" cy="8" r="7" fill={empty ? c : "#fff"} />
      <rect x="14" y="22" width="72" height="62" rx="18" fill={c} />
      <rect x="24" y="36" width="52" height="26" rx="13" fill="#0b0e14" />
      {!empty && <><circle cx="38" cy="49" r="7" fill={masked ? "#ff3b3b" : "#fff"} /><circle cx="62" cy="49" r="7" fill={masked ? "#ff3b3b" : "#fff"} /></>}
    </svg>
  );
}
