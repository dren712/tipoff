// Small synthesised sound effects, so the game needs no audio files.
let ctx: AudioContext | null = null;
let muted = localStorage.getItem("tipoff-mute") === "1";

export const isMuted = () => muted;
export function setMuted(m: boolean) { muted = m; localStorage.setItem("tipoff-mute", m ? "1" : "0"); }

function tone(freq: number, dur: number, type: OscillatorType = "sine", gain = 0.06, delay = 0, slide = 0) {
  if (muted) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur);
  } catch { /* audio is optional */ }
}

export const sfx = {
  tick: (up: boolean) => tone(up ? 660 : 440, 0.06, "square", 0.025),
  mine: (up: boolean) => { tone(up ? 520 : 392, 0.08, "triangle", 0.08); tone(up ? 784 : 294, 0.12, "triangle", 0.08, 0.07); },
  news: (up: boolean) => { tone(up ? 300 : 500, 0.45, "sawtooth", 0.07, 0, up ? 600 : -350); tone(up ? 900 : 150, 0.3, "square", 0.04, 0.4); },
  role: (insider: boolean) => insider ? [196, 233, 277].forEach((f, i) => tone(f, 0.5, "sawtooth", 0.05, i * 0.16)) : [523, 659].forEach((f, i) => tone(f, 0.18, "triangle", 0.07, i * 0.1)),
  bell: () => [880, 1108, 880].forEach((f, i) => tone(f, 0.35, "sine", 0.09, i * 0.18)),
  vote: () => tone(330, 0.2, "square", 0.05, 0, -120),
  drum: () => Array.from({ length: 10 }, (_, i) => tone(110, 0.07, "triangle", 0.09, i * 0.14)),
  caught: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, "triangle", 0.08, i * 0.11)),
  escaped: () => [392, 349, 311, 233].forEach((f, i) => tone(f, 0.4, "sawtooth", 0.05, i * 0.16)),
};
