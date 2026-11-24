const PATHS: Record<string, string> = {
  back: "M15 5l-7 7 7 7",
  close: "M6 6l12 12M18 6L6 18",
  up: "M12 5l8 12H4z",
  down: "M12 19L4 7h16z",
  sound: "M4 9v6h4l5 4V5L8 9H4zM16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12",
  mute: "M4 9v6h4l5 4V5L8 9H4zM17 9.5l5 5M22 9.5l-5 5",
  tape: "M4 6h16M4 12h16M4 18h10",
  shield: "M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6l8-3zM9 12l2.2 2.2L15.5 10",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3",
  check: "M5 12.5l4.5 4.5L19 7.5",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7l1-8z",
  gavel: "M14 4l6 6-3 3-6-6 3-3zM12.5 8.5L4 17l3 3 8.5-8.5M3 21h9",
  seat: "M7 4v8h10V4M5 12h14v4H5zM7 16v4M17 16v4",
  play: "M7 4l13 8-13 8z",
  link: "M14 5h5v5M19 5l-8 8M11 7H5v12h12v-6",
  clock: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3.5 2",
};
const SOLID = new Set(["up", "down", "play", "bolt"]);

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  const solid = SOLID.has(name);
  return (
    <svg className="icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"
      fill={solid ? "currentColor" : "none"} stroke={solid ? "none" : "currentColor"} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}

/// The Tipoff mark: a price line that jumps, read as an eyebrow raised.
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg className="logo" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#ffc531" />
      <path d="M5 21l7-7 5 4 10-11" stroke="#12122b" strokeWidth="3.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="27" cy="7" r="3" fill="#12122b" />
    </svg>
  );
}
