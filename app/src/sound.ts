// Sound: CC0 samples from app/public/assets/sfx (see the README there), played through Web Audio.
type Step = { name: string; gain: number; at?: number; rate?: number };

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let music: HTMLAudioElement | null = null;
let muted = localStorage.getItem("tipoff-mute") === "1";
let warmed = false;
let playEpoch = 0;
let tickUntil = 0;
let lastMineAt = 0;
let lastNewsAt = 0;
let lastBellAt = -1e9;

const buffers = new Map<string, Promise<AudioBuffer | null>>();
const active = new Set<AudioBufferSourceNode>();
const url = (f: string) => `${import.meta.env.BASE_URL}assets/sfx/${f}`;

// Per-sample gain normalization (measured in dBFS so every random variant hits the same loudness).
const FOOT_GAINS = [0.22, 0.19, 0.28, 0.22, 0.37, 0.45, 0.27, 0.27, 0.15, 0.32];
const STACK_GAINS = [0.50, 0.55, 0.56, 0.42, 0.54, 0.48];
const MUSIC_VOL = 0.06;
const PRELOAD = [
  "confirmation_001", "select_003", "error_004", "glitch_002", "bong_001",
  "lowFrequency_explosion_001", "impactMetal_002", "forceField_002", "doorOpen_001",
  "laserSmall_002", "phaserUp3", "phaserDown2", "powerUp5", "zapThreeToneDown",
  "metalLatch", "handleCoins", "begin", "tick_001", "jingle_caught", "jingle_escaped", "winner",
  "chips-stack-1", "chips-stack-2", "chips-stack-3", "chips-stack-4", "chips-stack-5", "chips-stack-6",
  "footstep00", "footstep01", "footstep02", "footstep03", "footstep04",
  "footstep05", "footstep06", "footstep07", "footstep08", "footstep09",
];

function audio(): AudioContext | null {
  try {
    if (!ctx) {
      ctx = new AudioContext();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -8;
      comp.knee.value = 12;
      comp.ratio.value = 6;
      comp.attack.value = 0.003;
      comp.release.value = 0.15;
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  } catch { return null; }
}

function load(name: string): Promise<AudioBuffer | null> {
  const cached = buffers.get(name);
  if (cached) return cached;
  const c = audio();
  if (!c) return Promise.resolve(null);
  const p = fetch(url(`${name}.ogg`))
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()))
    .then((a) => c.decodeAudioData(a))
    .catch(() => { buffers.delete(name); return null; });
  buffers.set(name, p);
  return p;
}

function warm() {
  if (warmed) return;
  warmed = true;
  for (const name of PRELOAD) void load(name);
}

function stopAll() {
  playEpoch++;
  for (const src of active) {
    try { src.stop(); src.disconnect(); } catch {}
  }
  active.clear();
  tickUntil = 0;
}

function sequence(steps: Step[], extraDelay = 0) {
  if (muted) return;
  const c = audio();
  if (!c || !master) return;
  const ep = playEpoch;
  const requestedAt = performance.now();
  void Promise.all(steps.map((s) => load(s.name))).then((bufs) => {
    if (muted || ep !== playEpoch || !master) return;
    const elapsed = (performance.now() - requestedAt) / 1000;
    const base = c.currentTime + Math.max(0, extraDelay - elapsed);
    for (let i = 0; i < steps.length; i++) {
      const buf = bufs[i], st = steps[i];
      if (!buf) continue;
      const src = c.createBufferSource(), g = c.createGain();
      src.buffer = buf;
      src.playbackRate.value = st.rate ?? 1;
      g.gain.value = st.gain;
      src.connect(g).connect(master);
      active.add(src);
      src.onended = () => active.delete(src);
      src.start(base + (st.at ?? 0));
    }
  });
}

function play(name: string, gain: number, delay = 0, rate = 1) {
  sequence([{ name, gain, at: delay, rate }]);
}

export const isMuted = () => muted;

export function setMuted(m: boolean) {
  muted = m;
  localStorage.setItem("tipoff-mute", m ? "1" : "0");
  if (m) {
    stopAll();
    if (master && ctx) master.gain.setValueAtTime(0, ctx.currentTime);
    if (music) { music.muted = true; music.pause(); }
    return;
  }
  const c = audio();
  if (master && c) master.gain.setValueAtTime(1, c.currentTime);
  warm();
  startMusic();
  if (music) {
    music.muted = false;
    music.volume = MUSIC_VOL;
    void music.play().catch(() => {});
  }
}

/// Starts the music loop and preloads sound effects. Retries on interaction until unlocked.
export function startMusic() {
  audio();
  warm();
  if (!music) {
    music = new Audio(url("music.mp3"));
    music.loop = true;
    music.volume = MUSIC_VOL;
    music.muted = muted;
  }
  if (!muted && music.paused) {
    void music.play().catch(() => {});
  }
}

function drumSteps(): Step[] {
  const steps: Step[] = [];
  let at = 0;
  for (let i = 0; i < 14; i++) {
    const t = i / 13;
    steps.push({ name: "tick_001", gain: 0.2 + t * 0.36, at, rate: 0.78 + t * 0.34 });
    at += 0.145 - t * 0.065;
  }
  return steps;
}

export const sfx = {
  tick: (up: boolean) => {
    if (muted) return;
    const now = performance.now() / 1000;
    if (now < tickUntil - 0.14) return;
    const delay = Math.max(0, tickUntil - now);
    tickUntil = now + delay + 0.075;
    const idx = Math.floor(Math.random() * 10);
    play(`footstep0${idx}`, FOOT_GAINS[idx], delay, up ? 1.12 : 0.92);
  },
  mine: (up: boolean) => {
    const now = performance.now();
    if (now - lastMineAt < 50) return;
    lastMineAt = now;
    const sIdx = Math.floor(Math.random() * 6);
    sequence([
      { name: up ? "confirmation_001" : "select_003", gain: up ? 0.25 : 0.6, at: 0 },
      { name: `chips-stack-${sIdx + 1}`, gain: STACK_GAINS[sIdx], at: 0.06 },
    ]);
  },
  denied: () => play("error_004", 0.28),
  news: (up: boolean) => {
    const now = performance.now();
    if (now - lastNewsAt < 400) return;
    lastNewsAt = now;
    sequence([
      { name: "lowFrequency_explosion_001", gain: 0.34, at: 0 },
      { name: up ? "phaserUp3" : "phaserDown2", gain: up ? 1.25 : 1.15, at: 0.04 },
      { name: "handleCoins", gain: 0.45, at: 0.42 },
    ]);
  },
  tip: () => play("glitch_002", 0.22),
  bell: () => {
    lastBellAt = performance.now();
    sequence([
      { name: "doorOpen_001", gain: 0.32, at: 0 },
      { name: "bong_001", gain: 0.45, at: 0.14 },
    ]);
  },
  role: (insider: boolean) => {
    const waitForBell = Math.max(0, 0.55 - (performance.now() - lastBellAt) / 1000);
    sequence([
      { name: insider ? "forceField_002" : "powerUp5", gain: insider ? 0.25 : 2.2, at: 0 },
      { name: "begin", gain: 0.3, at: insider ? 0.6 : 0.4 },
    ], waitForBell);
  },
  sudden: () => play("sudden_death", 0.28),
  count: (n: 1 | 2 | 3) => play(String(n), 0.28),
  time: () => sequence([
    { name: "bong_001", gain: 0.36, at: 0 },
    { name: "time", gain: 0.28, at: 0.16 },
  ]),
  vote: () => sequence([
    { name: "metalLatch", gain: 0.45, at: 0 },
    { name: "laserSmall_002", gain: 0.36, at: 0.09 },
  ]),
  drum: () => sequence(drumSteps()),
  caught: () => sequence([
    { name: "impactMetal_002", gain: 0.45, at: 0 },
    { name: "jingle_caught", gain: 0.25, at: 0.28 },
    { name: "winner", gain: 0.3, at: 0.6 },
  ]),
  escaped: () => sequence([
    { name: "zapThreeToneDown", gain: 2.4, at: 0 },
    { name: "jingle_escaped", gain: 0.42, at: 0.35 },
    { name: "handleCoins", gain: 0.48, at: 0.8 },
  ]),
};

if (typeof window !== "undefined") {
  const unlock = () => {
    startMusic();
    if (music && (muted || !music.paused)) {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    }
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}
