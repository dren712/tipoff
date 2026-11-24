// Sound: CC0 samples from app/public/assets/sfx (see the README there), played through Web Audio.
let ctx: AudioContext | null = null;
let music: HTMLAudioElement | null = null;
let muted = localStorage.getItem("tipoff-mute") === "1";
const buffers = new Map<string, Promise<AudioBuffer | null>>();
const url = (f: string) => `${import.meta.env.BASE_URL}assets/sfx/${f}`;

export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  localStorage.setItem("tipoff-mute", m ? "1" : "0");
  if (music) m ? music.pause() : void music.play().catch(() => {});
}

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch { return null; }
}

function load(name: string) {
  let b = buffers.get(name);
  if (!b) {
    b = fetch(url(`${name}.ogg`)).then((r) => r.arrayBuffer()).then((a) => audio()!.decodeAudioData(a)).catch(() => null);
    buffers.set(name, b);
  }
  return b;
}

function play(name: string, gain = 0.5, delay = 0, rate = 1) {
  if (muted) return;
  void load(name).then((buf) => {
    const c = audio();
    if (!buf || !c || muted) return;
    const src = c.createBufferSource(), g = c.createGain();
    src.buffer = buf;
    src.playbackRate.value = rate;
    g.gain.value = gain;
    src.connect(g).connect(c.destination);
    src.start(c.currentTime + delay);
  });
}

const any = (base: string, n: number, from = 1) => `${base}${from + Math.floor(Math.random() * n)}`;

/// Starts the music loop. Browsers only allow this after a click, so call it from one.
export function startMusic() {
  if (music) return;
  music = new Audio(url("music.mp3"));
  music.loop = true;
  music.volume = 0.16;
  if (!muted) void music.play().catch(() => { music = null; });
}

export const sfx = {
  tick: (up: boolean) => play(`footstep0${Math.floor(Math.random() * 10)}`, 0.22, 0, up ? 1.15 : 0.9),
  mine: (up: boolean) => { play(up ? "confirmation_001" : "select_003", 0.5); play(any("chips-stack-", 6), 0.5, 0.03); },
  denied: () => play("error_004", 0.6),
  news: (up: boolean) => { play("lowFrequency_explosion_000", 0.9); play(up ? "phaserUp3" : "phaserDown2", 0.45, 0.05); play("handleCoins", 0.5, 0.35); },
  tip: () => play("glitch_002", 0.6),
  role: (insider: boolean) => { play(insider ? "forceField_002" : "powerUp5", 0.5); play("begin", 0.6, 0.5); },
  bell: () => { play("doorOpen_001", 0.5); play("prepare_yourself", 0.6, 0.2); },
  sudden: () => play("sudden_death", 0.7),
  count: (n: 1 | 2 | 3) => play(String(n), 0.6),
  time: () => { play("bong_001", 0.7); play("time", 0.7, 0.1); },
  vote: () => { play("metalLatch", 0.6); play("laserSmall_002", 0.3, 0.05); },
  drum: () => { for (let i = 0; i < 10; i++) play("tick_001", 0.5, i * 0.14, 0.7); },
  caught: () => { play("impactMetal_002", 0.8); play("jingle_caught", 0.6, 0.15); play("winner", 0.6, 0.6); },
  escaped: () => { play("zapThreeToneDown", 0.5); play("jingle_escaped", 0.6, 0.2); play("handleCoins", 0.6, 0.4); },
};

if (typeof window !== "undefined") window.addEventListener("pointerdown", startMusic, { once: true });
