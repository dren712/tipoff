import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

export type Stage = "idle" | "deal" | "live" | "vote" | "drum" | "reveal";
export type SeatView = { empty: boolean; pos: number; mood: number };
export type Wall = {
  price: number; open: number; elapsed: number; round: number;
  points: { t: number; p: number }[];
  marks: { t: number; p: number; seat: number; delta: number }[];
  shocks: { at: number; bps: number }[];
  future: { at: number; bps: number }[];
  title: string; sub: string;
};
export type View = { stage: Stage; seats: SeatView[]; me: number; insiderMe: boolean; insider: number; caught: boolean; wall: Wall };

const N = 6, TILE = 1.6, GREEN = 0x3ddc97, RED = 0xff5c6c, MAGENTA = 0xff3df0, GOLD = 0xf5b83d;
const laneX = (i: number) => (i - 2.5) * 2;
const VAULT = new THREE.Vector3(-10.5, 4.2, -9);

type Bot = {
  root: THREE.Group; body: THREE.Object3D; mixer: THREE.AnimationMixer; actions: Record<string, THREE.AnimationAction>; current: string;
  main: THREE.MeshStandardMaterial; face?: THREE.Mesh; ring: THREE.Mesh; pulse: THREE.Mesh; spot: THREE.SpotLight; beam: THREE.Mesh;
  hold: boolean; moving: boolean; down: number; yaw: number; trail: number;
};
type Coin = { p: THREE.Vector3; v: THREE.Vector3; life: number };

function label(text: string, color: string, w = 512, h = 128) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  g.font = `900 ${h * 0.72}px Inter, system-ui, sans-serif`;
  g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = color;
  g.fillText(text, w / 2, h / 2 + 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: t, transparent: true, toneMapped: false, side: THREE.DoubleSide });
}

/// The Floor: six robots on six lanes of a deck balanced over the pit. Where a robot stands is its position:
/// toward the green gate is long, toward the red gate is short. News makes the deck lurch.
export class Scene3D {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300);
  private clock = new THREE.Clock();
  private deck = new THREE.Group();
  private bots: Bot[] = [];
  private tiles: THREE.InstancedMesh;
  private prints: { m: THREE.Mesh; life: number }[] = [];
  private printAt = 0;
  private coins: Coin[] = [];
  private coinMesh: THREE.InstancedMesh;
  private wave: THREE.Mesh;
  private waveT = 9;
  private cage = new THREE.Group();
  private nearGate = new THREE.Group();
  private vault = new THREE.Group();
  private wallCanvas = document.createElement("canvas");
  private wallTex: THREE.CanvasTexture;
  private wallMat: THREE.MeshBasicMaterial;
  private amb = new THREE.HemisphereLight(0x3a4c9a, 0x05060c, 0.6);
  private key = new THREE.DirectionalLight(0xffe2c0, 1.3);
  private alarm = new THREE.PointLight(0xff3030, 0, 70);
  private view: View | null = null;
  private camPos = new THREE.Vector3(0, 8, 22);
  private camLook = new THREE.Vector3(0, 1, 0);
  private look = new THREE.Vector3(0, 1, 0);
  private fov = 50;
  private shake = 0;
  private flash = 0;
  private flashColor = new THREE.Color();
  private slow = 0;
  private tilt = 0;
  private tiltV = 0;
  private tiltTo = 0;
  private stageAt = 0;
  private raf = 0;
  private ray = new THREE.Raycaster();
  private disposed = false;
  private tmp = new THREE.Object3D();
  private col = new THREE.Color();
  ready = false;
  /// Lobby backdrop: circle the floor instead of framing a seat.
  orbit = false;

  constructor(private host: HTMLElement, private colors: string[], private tags: () => (HTMLElement | null)[], private onPick: (seat: number) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x05060f);
    this.scene.fog = new THREE.FogExp2(0x070a18, 0.014);
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;

    this.key.position.set(7, 14, 9);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    Object.assign(this.key.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 45 });
    this.alarm.position.set(0, 9, 0);
    this.scene.add(this.amb, this.key, this.alarm, this.deck, this.spotL);

    // The deck: a slab balanced on a pivot over the pit.
    const metal = new THREE.MeshStandardMaterial({ color: 0x0d1220, roughness: 0.32, metalness: 0.85 });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(12.6, 0.5, 19), metal);
    slab.position.y = -0.26;
    slab.receiveShadow = true;
    this.deck.add(slab);
    const edge = new THREE.MeshBasicMaterial({ color: 0x2b6cff, toneMapped: false });
    for (const x of [-6.34, 6.34]) { const e = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 19), edge); e.position.set(x, 0.02, 0); this.deck.add(e); }
    for (let i = 1; i < N; i++) { const e = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.02, 18.4), new THREE.MeshBasicMaterial({ color: 0x1a2440 })); e.position.set(laneX(i) - 1, 0.011, 0); this.deck.add(e); }
    const tile = new THREE.PlaneGeometry(1.84, 1.46).rotateX(-Math.PI / 2);
    this.tiles = new THREE.InstancedMesh(tile, new THREE.MeshBasicMaterial({ toneMapped: false }), N * 11);
    for (let i = 0; i < N; i++) for (let p = -5; p <= 5; p++) {
      this.tmp.position.set(laneX(i), 0.012, -p * TILE); this.tmp.rotation.set(0, 0, 0); this.tmp.scale.setScalar(1); this.tmp.updateMatrix();
      this.tiles.setMatrixAt(i * 11 + p + 5, this.tmp.matrix);
      this.tiles.setColorAt(i * 11 + p + 5, this.col.set(0));
    }
    this.deck.add(this.tiles);
    // Gates: LONG at the far end under the jumbotron, SHORT at the near end.
    for (const [z, hex, text] of [[-9.6, GREEN, "LONG"], [9.6, RED, "SHORT"]] as const) {
      const m = new THREE.MeshStandardMaterial({ color: 0x05070c, emissive: hex, emissiveIntensity: 1.6, roughness: 0.5 });
      const gate = z > 0 ? this.nearGate : this.deck;
      const near = z > 0, ph = near ? 1.1 : 4;
      for (const x of [-6.1, 6.1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, ph, 0.3), m); post.position.set(x, ph / 2, z); gate.add(post); }
      const top = new THREE.Mesh(new THREE.BoxGeometry(12.5, near ? 0.12 : 0.3, 0.3), m); top.position.set(0, near ? 0.06 : 4, z); gate.add(top);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.1), label(text, "#" + new THREE.Color(hex).getHexString()));
      if (near) { sign.rotation.x = -Math.PI / 2; sign.position.set(0, 0.03, 8.75); sign.scale.setScalar(0.8); } else sign.position.set(0, 4.85, z);
      gate.add(sign);
    }
    const pivot = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 2.4, 13, 6), metal);
    pivot.position.y = -7;
    this.scene.add(pivot);
    // The pit below, and pillars of old candles around it.
    const pit = new THREE.GridHelper(260, 130, 0x2b3cff, 0x121a44);
    pit.position.y = -13;
    this.scene.add(pit);
    const count = 110, sky = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), count);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2, r = 34 + Math.random() * 30, h = 6 + Math.random() * 26;
      this.tmp.position.set(Math.cos(a) * r, -13 + h / 2, Math.sin(a) * r - 6); this.tmp.scale.set(1.4, h, 1.4); this.tmp.updateMatrix();
      sky.setMatrixAt(i, this.tmp.matrix);
      sky.setColorAt(i, this.col.set(Math.random() > 0.45 ? 0x0f6b4c : 0x7a1f2b).multiplyScalar(0.25 + Math.random() * 0.45));
    }
    this.scene.add(sky);

    // The jumbotron.
    this.wallCanvas.width = 1536;
    this.wallCanvas.height = 672;
    this.wallTex = new THREE.CanvasTexture(this.wallCanvas);
    this.wallTex.colorSpace = THREE.SRGBColorSpace;
    this.wallMat = new THREE.MeshBasicMaterial({ map: this.wallTex, toneMapped: false });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(18, 7.9), this.wallMat);
    wall.position.set(0, 8.7, -13);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(18.5, 8.4, 0.5), metal);
    frame.position.set(0, 8.7, -13.3);
    this.scene.add(wall, frame);

    // The Vault: the TEE, where the insider's name and the news are sealed.
    const cube = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 2.4), new THREE.MeshStandardMaterial({ color: 0x050308, roughness: 0.15, metalness: 1 }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry), new THREE.LineBasicMaterial({ color: MAGENTA, toneMapped: false }));
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.7), new THREE.MeshBasicMaterial({ color: MAGENTA, toneMapped: false, wireframe: true }));
    this.vault.add(cube, edges, core);
    this.vault.position.copy(VAULT);
    const tag = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.6), label("SEALED · TEE", "#ff8af7", 768, 110));
    tag.position.set(VAULT.x, VAULT.y + 2.1, VAULT.z);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 16), new THREE.MeshBasicMaterial({ color: 0x5a1a66, toneMapped: false }));
    stem.position.set(VAULT.x, VAULT.y - 9.5, VAULT.z);
    this.scene.add(this.vault, tag, stem);

    // Effects.
    const coin = new THREE.CylinderGeometry(0.13, 0.13, 0.04, 10);
    this.coinMesh = new THREE.InstancedMesh(coin, new THREE.MeshStandardMaterial({ color: GOLD, emissive: GOLD, emissiveIntensity: 0.7, metalness: 1, roughness: 0.25 }), 260);
    this.coinMesh.frustumCulled = false;
    this.tmp.scale.setScalar(0); this.tmp.updateMatrix();
    for (let i = 0; i < 260; i++) { this.coinMesh.setMatrixAt(i, this.tmp.matrix); this.coins.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0 }); }
    this.wave = new THREE.Mesh(new THREE.BoxGeometry(12.4, 0.5, 0.35), new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0 }));
    const foot = new THREE.PlaneGeometry(0.62, 0.42).rotateX(-Math.PI / 2);
    for (let i = 0; i < 96; i++) {
      const m = new THREE.Mesh(foot, new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0, depthWrite: false }));
      m.visible = false; this.deck.add(m); this.prints.push({ m, life: 0 });
    }
    for (let k = 0; k < 12; k++) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 5), new THREE.MeshBasicMaterial({ color: RED, toneMapped: false }));
      bar.position.set(Math.cos((k / 12) * 6.283) * 1.15, 2.5, Math.sin((k / 12) * 6.283) * 1.15);
      this.cage.add(bar);
    }
    this.cage.visible = false;
    this.deck.add(this.coinMesh, this.wave, this.cage, this.nearGate);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.45, 0.78);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
    new ResizeObserver(() => this.resize()).observe(host);
    this.renderer.domElement.addEventListener("click", this.click);
    this.renderer.domElement.addEventListener("pointermove", this.hover);
    this.load();
    this.loop();
  }

  private async load() {
    const gltf = await new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}robot.glb`);
    if (this.disposed) return;
    const beamGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 6).rotateX(Math.PI / 2);
    for (let i = 0; i < N; i++) {
      const root = new THREE.Group(), body = cloneSkinned(gltf.scene), col = new THREE.Color(this.colors[i]);
      body.scale.setScalar(0.45);
      let main!: THREE.MeshStandardMaterial, face: THREE.Mesh | undefined;
      body.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
        if (mat.name === "Main") { mat.color.copy(col); main ??= mat; mesh.material = main; } else mesh.material = mat;
        if (mesh.morphTargetDictionary) face = mesh;
      });
      root.add(body);
      root.position.set(laneX(i), 0, 0);
      root.rotation.y = Math.PI;
      root.userData.seat = i;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.78, 0.92, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: col, toneMapped: false, transparent: true, opacity: 0 }));
      ring.position.y = 0.03;
      const pulse = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.58, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0 }));
      pulse.position.y = 0.035;
      root.add(ring, pulse);
      const spot = this.spotL;
      const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0 }));
      beam.frustumCulled = false;
      this.deck.add(root);
      this.scene.add(beam);
      const mixer = new THREE.AnimationMixer(body), actions: Record<string, THREE.AnimationAction> = {};
      for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip);
      actions.Idle.time = Math.random() * 2;
      actions.Idle.play();
      const bot: Bot = { root, body, mixer, actions, current: "Idle", main, face, ring, pulse, spot, beam, hold: false, moving: false, down: 0, yaw: Math.PI, trail: 0 };
      mixer.addEventListener("finished", () => { if (!bot.hold) this.play(bot, "Idle"); });
      this.bots.push(bot);
    }
    this.ready = true;
    if (this.view) this.set(this.view);
  }

  private play(b: Bot, name: string, once = false, hold = false) {
    if (b.current === name && !once) return;
    const next = b.actions[name], prev = b.actions[b.current];
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    next.clampWhenFinished = hold;
    b.hold = hold;
    if (prev !== next) next.crossFadeFrom(prev, 0.15, false);
    next.play();
    b.current = name;
  }

  private express(b: Bot, name: "Angry" | "Surprised" | "Sad" | null) {
    const d = b.face?.morphTargetDictionary, inf = b.face?.morphTargetInfluences;
    if (!d || !inf) return;
    for (const k of Object.keys(d)) inf[d[k]] = k === name ? 1 : 0;
  }

  private lined(stage: Stage) { return stage === "vote" || stage === "drum" || stage === "reveal"; }
  /// Where a robot should stand, in deck space.
  private spot(i: number, v: View) {
    return this.lined(v.stage) ? new THREE.Vector3(laneX(i) * 0.92, 0, 6.6 + Math.abs(i - 2.5) * 0.25) : new THREE.Vector3(laneX(i), 0, -v.seats[i].pos * TILE);
  }

  /// A trade landed: ring the tile under the robot.
  trade(seat: number, delta: number) {
    const b = this.bots[seat];
    if (!b || this.view?.stage !== "live") return;
    const m = b.pulse.material as THREE.MeshBasicMaterial;
    m.color.set(delta > 0 ? GREEN : RED);
    m.opacity = 1;
    b.pulse.scale.setScalar(1);
  }

  /// News hits: the deck lurches, robots on the wrong side are thrown, the right side cashes in.
  news(bps: number) {
    const v = this.view;
    this.shake = 0.6; this.flash = 1; this.slow = 0.4; this.waveT = 0; this.tiltV += bps > 0 ? 1.6 : -1.6;
    this.flashColor.set(bps > 0 ? GREEN : RED);
    (this.wave.material as THREE.MeshBasicMaterial).color.copy(this.flashColor);
    if (!v) return;
    this.bots.forEach((b, i) => {
      const s = v.seats[i];
      if (s.empty) return;
      const side = Math.sign(s.pos) * Math.sign(bps), lots = Math.abs(s.pos);
      if (side > 0) {
        this.play(b, lots >= 3 ? "ThumbsUp" : "Jump", true); this.express(b, null);
        this.fountain(b.root.position, lots * 7);
      } else if (side < 0 && lots >= 4) {
        this.play(b, "Death", true, true); this.express(b, "Surprised"); b.down = 1.3;
      } else if (side < 0) { this.play(b, "No", true); this.express(b, "Sad"); }
      else this.play(b, "Jump", true);
    });
  }

  private fountain(at: THREE.Vector3, n: number) {
    for (const c of this.coins) {
      if (n <= 0) break;
      if (c.life > 0) continue;
      c.p.set(at.x, 1.7, at.z);
      c.v.set((Math.random() - 0.5) * 3.2, 5 + Math.random() * 4, (Math.random() - 0.5) * 3.2);
      c.life = 1.6 + Math.random() * 0.5;
      n--;
    }
  }

  set(v: View) {
    const prev = this.view;
    this.view = v;
    if (!this.ready) return;
    const changed = prev?.stage !== v.stage;
    if (changed) this.stageAt = this.clock.elapsedTime;
    this.tiltTo = v.stage === "live" ? THREE.MathUtils.clamp((v.wall.shocks.reduce((a, s) => a + s.bps, 0) / 250) * 2.2, -7, 7) * (Math.PI / 180) : 0;
    this.nearGate.visible = !this.lined(v.stage);
    this.cage.visible = v.stage === "reveal" && v.caught && !!this.bots[v.insider];
    this.bots.forEach((b, i) => {
      const s = v.seats[i], col = this.col.set(this.colors[i]);
      if (v.stage !== "reveal") b.body.visible = !s.empty;
      (b.ring.material as THREE.MeshBasicMaterial).opacity = i === v.me ? 0.95 : 0;
      (b.ring.material as THREE.MeshBasicMaterial).color.set(i === v.me && v.insiderMe ? MAGENTA : col);
      if (changed || (v.stage !== "reveal" && prev?.seats[i].empty !== s.empty)) {
        b.main.color.copy(col);
        b.main.emissive.set(0);
        b.down = 0;
        this.express(b, null);
        if (!b.moving) this.play(b, "Idle");
        if (v.stage === "deal") this.play(b, "Standing", true);
        if (v.stage === "drum") this.express(b, "Surprised");
        if (v.stage === "reveal") {
          if (i === v.insider) {
            b.main.color.set(0x14060f);
            b.main.emissive.set(MAGENTA).multiplyScalar(0.55);
            this.express(b, v.caught ? "Sad" : "Angry");
            v.caught ? this.play(b, "Death", true, true) : this.play(b, "Dance");
            if (v.caught) this.cage.position.set(b.root.position.x, 6, b.root.position.z); else this.fountain(b.root.position, 60);
          } else {
            this.express(b, v.caught ? null : "Sad");
            setTimeout(() => this.view?.stage === "reveal" && this.play(b, v.caught ? "Jump" : "No", true), 300 + i * 90);
          }
        }
      } else if (v.stage === "live" && b.current === "Idle") this.express(b, s.mood < 0 ? "Sad" : null);
    });
    this.drawWall(v.wall);
  }

  private drawWall(w: Wall) {
    const c = this.wallCanvas.getContext("2d")!, W = this.wallCanvas.width, H = this.wallCanvas.height;
    c.fillStyle = "#070b12";
    c.fillRect(0, 0, W, H);
    const up = w.price >= w.open, usd = (p: number) => (p / 1e8).toFixed(2);
    c.textBaseline = "top";
    const x0 = 50, x1 = W - 110, y0 = 50, y1 = H - 60, X = (t: number) => x0 + (t / 60) * (x1 - x0);
    const ps = [...w.points.map((p) => p.p), ...w.marks.map((m) => m.p), w.open || w.price].filter(Boolean);
    let lo = Math.min(...ps), hi = Math.max(...ps);
    const pad = Math.max((hi - lo) * 0.15, (w.open || 1) * 0.004);
    lo -= pad; hi += pad;
    const Y = (p: number) => y1 - ((p - lo) / (hi - lo)) * (y1 - y0);
    c.strokeStyle = "#141c2b";
    c.lineWidth = 2;
    for (let t = 0; t <= 60; t += 10) { c.beginPath(); c.moveTo(X(t), y0); c.lineTo(X(t), y1); c.stroke(); }
    c.fillStyle = "#4b5875";
    c.font = "600 22px Inter, system-ui, sans-serif";
    for (let t = 0; t <= 60; t += 10) c.fillText(`${t}s`, X(t) - 12, y1 + 12);
    if (ps.length) {
      c.fillText(usd(hi), x1 + 14, y0 - 6);
      c.fillText(usd(lo), x1 + 14, y1 - 22);
      if (w.open) { c.setLineDash([8, 10]); c.strokeStyle = "#33405c"; c.beginPath(); c.moveTo(x0, Y(w.open)); c.lineTo(x1, Y(w.open)); c.stroke(); c.setLineDash([]); }
    }
    for (const s of w.shocks) {
      c.strokeStyle = c.fillStyle = s.bps > 0 ? "#3ddc97" : "#ff6b6b";
      c.lineWidth = 3;
      c.setLineDash([10, 8]); c.beginPath(); c.moveTo(X(s.at), y0); c.lineTo(X(s.at), y1); c.stroke(); c.setLineDash([]);
      c.font = "800 24px Inter, system-ui, sans-serif";
      c.fillText(`NEWS ${s.bps > 0 ? "+" : "−"}${(Math.abs(s.bps) / 100).toFixed(1)}%`, X(s.at) + 8, y0 + 4);
    }
    for (const s of w.future) {
      c.strokeStyle = c.fillStyle = "#f5b83d";
      c.lineWidth = 3;
      c.setLineDash([4, 10]); c.beginPath(); c.moveTo(X(s.at), y0); c.lineTo(X(s.at), y1); c.stroke(); c.setLineDash([]);
      c.font = "800 24px Inter, system-ui, sans-serif";
      c.fillText(`TIP ${s.bps > 0 ? "+" : "−"}${(Math.abs(s.bps) / 100).toFixed(1)}%`, X(s.at) + 8, y1 - 34);
    }
    if (w.points.length > 1) {
      c.lineJoin = "round";
      c.lineWidth = 6;
      c.strokeStyle = up ? "#3ddc97" : "#ff6b6b";
      c.shadowColor = c.strokeStyle;
      c.shadowBlur = 18;
      c.beginPath();
      w.points.forEach((p, i) => (i ? c.lineTo(X(p.t), Y(p.p)) : c.moveTo(X(p.t), Y(p.p))));
      c.stroke();
      c.shadowBlur = 0;
      const last = w.points[w.points.length - 1];
      c.fillStyle = "#fff";
      c.beginPath(); c.arc(X(last.t), Y(last.p), 9, 0, 7); c.fill();
    }
    for (const m of w.marks) {
      const x = X(m.t), y = Y(m.p), d = m.delta > 0 ? -1 : 1;
      c.fillStyle = this.colors[m.seat];
      c.beginPath(); c.moveTo(x, y + d * 12); c.lineTo(x - 11, y + d * 32); c.lineTo(x + 11, y + d * 32); c.closePath(); c.fill();
    }
    this.wallTex.needsUpdate = true;
  }

  private pick(e: PointerEvent | MouseEvent): number {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hit = this.ray.intersectObjects(this.bots.map((b) => b.body), true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && o.userData.seat === undefined) o = o.parent;
    return o ? (o.userData.seat as number) : -1;
  }
  private hot = -1;
  private spotL = new THREE.SpotLight(0xffffff, 0, 24, 0.3, 0.6, 1.1);
  private quality = 2;
  private frames = 0;
  private spent = 0;
  /// Renderer facts for the proof panel and QA.
  stats() { const i = this.renderer.info; return { quality: this.quality, calls: i.render.calls, triangles: i.render.triangles, ratio: this.renderer.getPixelRatio() }; }
  private click = (e: MouseEvent) => { const s = this.pick(e); if (s >= 0 && this.view?.stage === "vote" && s !== this.view.me && !this.view.seats[s].empty) this.onPick(s); };
  private hover = (e: PointerEvent) => {
    const s = this.view?.stage === "vote" ? this.pick(e) : -1;
    this.hot = s >= 0 && s !== this.view!.me ? s : -1;
    this.renderer.domElement.style.cursor = this.hot >= 0 ? "pointer" : "";
  };

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /// Camera per stage. `a` pulls back on narrow screens so all six lanes stay in frame.
  private direct(v: View | null, t: number) {
    const a = Math.max(1, 1.5 / this.camera.aspect), stage = v?.stage ?? "idle";
    const meX = v && v.me >= 0 ? laneX(v.me) : 0, me = v && v.me >= 0 ? this.bots[v.me] : undefined;
    let fov = 50;
    if (this.orbit) { this.camPos.set(Math.sin(t * 0.08) * 20 * a, 7.5, Math.cos(t * 0.08) * 20 * a); this.camLook.set(0, 2.5, -2); }
    else if (stage === "live") {
      const last = v!.wall.elapsed >= 50, z = me ? me.root.position.z * 0.15 : 0;
      if (last) { this.camPos.set(meX * 0.4, 11, 21 * a + z); this.camLook.set(0, 1.2, 0.8); fov = 56; }
      else { this.camPos.set(meX * 0.4, 13, 22.5 * a + z); this.camLook.set(meX * 0.25, 1.2, 0.8); }
    } else if (stage === "deal" && me) { this.camPos.set(meX + 1.6, 2.1, -4.6 * a); this.camLook.set(meX, 1.5, 0); }
    else if (stage === "vote" || stage === "drum") { this.camPos.set(this.hot >= 0 ? laneX(this.hot) * 0.12 : 0, 2.7, 16.6 * a); this.camLook.set(0, 1.55, 6.6); }
    else if (stage === "reveal" && this.bots[v!.insider]) {
      const p = this.bots[v!.insider].root.position, k = Math.min(1, (t - this.stageAt) / 1.5);
      this.camPos.set(p.x * 0.8, 2.6, p.z + (9 - 2.5 * k) * a); this.camLook.set(p.x, 2.9, p.z);
    } else { this.camPos.set(Math.sin(t * 0.2) * 2.5, 6.2, 15 * a); this.camLook.set(0, 3.6, -4); }
    this.fov += ((this.flash > 0.75 ? fov - 6 : fov) - this.fov) * 0.12;
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const real = Math.min(this.clock.getDelta(), 0.5), raw = Math.min(real, 0.1), t = this.clock.elapsedTime, v = this.view;
    this.slow = Math.max(0, this.slow - raw);
    const dt = raw * (this.slow > 0 ? 0.3 : 1);
    const stage = v?.stage ?? "idle", dark = this.lined(stage), last = stage === "live" && v!.wall.elapsed >= 50;

    this.direct(v, t);
    const k = 1 - Math.exp(-raw * (stage === "idle" ? 1.2 : 3));
    this.camera.position.lerp(this.camPos, k);
    this.look.lerp(this.camLook, k);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - raw);
      this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.6;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.6;
    }
    this.camera.lookAt(this.look);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) { this.camera.fov = this.fov; this.camera.updateProjectionMatrix(); }

    // The deck is a spring: news kicks it, then it settles at the tilt the shocks have earned.
    this.tiltV += ((this.tiltTo - this.tilt) * 120 - this.tiltV * 9) * raw;
    this.tilt += this.tiltV * raw;
    this.deck.rotation.x = this.tilt;

    this.flash = Math.max(0, this.flash - raw * 0.9);
    this.amb.intensity += ((stage === "vote" ? 0.45 : dark ? 0.12 : 0.6) - this.amb.intensity) * k;
    this.key.intensity += ((dark ? 0.06 : last ? 0.7 : 1.3) - this.key.intensity) * k;
    const beat = last ? Math.max(0, 1 - ((v!.wall.elapsed % 1) * 3)) : 0;
    this.alarm.color.set(0xff3030);
    if (this.flash > 0) this.alarm.color.copy(this.flashColor);
    this.alarm.intensity = this.flash * 420 + beat * 160 + (stage === "drum" ? (Math.sin(t * 14) > 0 ? 120 : 0) : 0);
    this.wallMat.color.setScalar(dark ? 0.35 : 1).lerp(this.flashColor, this.flash * 0.5);
    this.bloom.strength = 0.6 + this.flash * 0.5 + (stage === "reveal" ? 0.25 : 0);
    this.vault.rotation.y += raw * (stage === "deal" ? 5 : 0.25);
    this.vault.children[2].rotation.x += raw * 1.5;

    // Tiles: a green ramp toward LONG, red toward SHORT; the tile a robot stands on takes its colour.
    const tip = v?.insiderMe && stage === "live" ? v.wall.future.find((s) => s.at - v.wall.elapsed > 0 && s.at - v.wall.elapsed < 6) : undefined;
    for (let i = 0; i < N; i++) for (let p = -5; p <= 5; p++) {
      const s = v?.seats[i], on = s && !s.empty && s.pos === p && !dark;
      if (on) this.col.set(this.colors[i]).multiplyScalar(0.95);
      else if (p === 0) this.col.setScalar(dark ? 0.02 : 0.11);
      else this.col.set(p > 0 ? GREEN : RED).multiplyScalar(dark ? 0.012 : 0.07 + Math.abs(p) * 0.03 + this.flash * 0.22 + beat * 0.04);
      if (tip && i === v!.me && Math.sign(p) === Math.sign(tip.bps) && !on) this.col.lerp(new THREE.Color(MAGENTA), 0.25 + 0.25 * Math.sin(t * 9));
      this.tiles.setColorAt(i * 11 + p + 5, this.col);
    }
    this.tiles.instanceColor!.needsUpdate = true;

    let chosen = -1;
    this.bots.forEach((b, i) => {
      b.mixer.update(dt);
      const s = v?.seats[i];
      b.down = Math.max(0, b.down - dt);
      if (b.down === 0 && b.current === "Death" && stage === "live") { this.play(b, "Idle"); this.express(b, "Sad"); }
      // Walk to where the chain says this robot stands.
      if (v && s && b.body.visible && b.down === 0 && !(stage === "reveal" && i === v.insider)) {
        const to = this.spot(i, v), d = to.sub(b.root.position), len = d.length();
        if (len > 0.04) {
          const step = Math.min(len, (dark ? 10 : 7.5) * real);
          b.root.position.addScaledVector(d, step / len);
          b.yaw = Math.atan2(d.x, d.z);
          b.trail += step;
          if (stage === "live" && b.trail > 0.75) { b.trail = 0; this.print(b.root.position, i); }
          if (!b.moving) { b.moving = true; this.play(b, "Running"); }
        } else if (b.moving) { b.moving = false; this.play(b, "Idle"); }
        if (!b.moving) b.yaw = dark ? 0 : Math.PI;
      }
      let dy = b.yaw - b.root.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      b.root.rotation.y += dy * Math.min(1, raw * 14);

      const pm = b.pulse.material as THREE.MeshBasicMaterial;
      if (pm.opacity > 0) { pm.opacity = Math.max(0, pm.opacity - raw * 2.2); b.pulse.scale.multiplyScalar(1 + raw * 4); }
      b.ring.scale.setScalar(1 + Math.sin(t * 3) * 0.05);

      const world = b.root.getWorldPosition(new THREE.Vector3());
      const lit = !b.body.visible ? 0 : stage === "vote" ? (this.hot === i ? 90 : 45) : stage === "drum" ? (Math.floor(t * 9) % N === i ? 90 : 3) : stage === "reveal" ? (i === v!.insider ? 110 : 0) : 0;
      if (lit > 80) { chosen = i; this.spotL.position.set(world.x, 11, world.z + 3); this.spotL.target = b.root; this.spotL.color.set(stage === "reveal" ? MAGENTA : 0xffffff); }

      // The deal: a beam from the Vault to every robot. Only yours is coloured, and only you see it.
      const bm = b.beam.material as THREE.MeshBasicMaterial, show = stage === "deal" && !s?.empty;
      bm.opacity += ((show ? 0.9 : 0) - bm.opacity) * Math.min(1, raw * 6);
      b.beam.visible = bm.opacity > 0.02;
      if (b.beam.visible) {
        const head = world.clone().setY(world.y + 1.9), len = head.distanceTo(VAULT);
        b.beam.position.copy(VAULT).lerp(head, 0.5);
        b.beam.lookAt(head);
        b.beam.scale.set(1, 1, len);
        bm.color.set(i === v!.me ? (v!.insiderMe ? MAGENTA : 0xffffff) : 0x4a5a9a);
      }

      const el = this.tags()[i];
      if (el) {
        const p = world.setY(world.y + 2.25).project(this.camera);
        el.style.transform = `translate(-50%,-100%) translate(${((p.x + 1) / 2) * this.host.clientWidth}px,${((1 - p.y) / 2) * this.host.clientHeight}px)`;
        el.style.opacity = p.z < 1 && stage !== "reveal" ? "1" : "0";
      }
    });

    this.spotL.intensity += ((chosen >= 0 ? 110 : 0) - this.spotL.intensity) * Math.min(1, raw * 8);
    // Footprints fade over ten seconds.
    for (const f of this.prints) {
      if (f.life <= 0) continue;
      f.life -= dt / 10;
      (f.m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, f.life) * 0.8;
      if (f.life <= 0 || stage !== "live") { f.life = 0; f.m.visible = false; }
    }
    // Coins.
    this.coins.forEach((c, i) => {
      if (c.life <= 0) return;
      c.life -= dt;
      c.v.y -= 14 * dt;
      c.p.addScaledVector(c.v, dt);
      if (c.p.y < 0.05 && c.v.y < 0) { c.p.y = 0.05; c.v.y *= -0.4; c.v.x *= 0.6; c.v.z *= 0.6; }
      this.tmp.position.copy(c.p); this.tmp.rotation.set(t * 9 + i, i, t * 7); this.tmp.scale.setScalar(c.life > 0 ? Math.min(1, c.life * 3) : 0); this.tmp.updateMatrix();
      this.coinMesh.setMatrixAt(i, this.tmp.matrix);
    });
    this.coinMesh.instanceMatrix.needsUpdate = true;
    // Shockwave down the lanes.
    this.waveT += raw;
    const wm = this.wave.material as THREE.MeshBasicMaterial;
    wm.opacity = this.waveT < 0.55 ? 0.9 * (1 - this.waveT / 0.55) : 0;
    this.wave.position.set(0, 0.25, -9 + (this.waveT / 0.55) * 18);
    if (this.cage.visible) { this.cage.position.y = Math.max(0, this.cage.position.y - raw * 14); this.cage.rotation.y += raw * 0.6; }

    this.composer.render();
    // Slow machine: drop shadows and resolution first, then bloom, so the game and its rollup calls stay responsive.
    this.frames++;
    this.spent += raw;
    if (this.frames === 45) {
      if (this.spent / 45 > 0.03 && this.quality > 0) {
        this.quality--;
        this.renderer.shadowMap.enabled = false;
        this.key.castShadow = false;
        this.bloom.enabled = this.quality > 0;
        this.renderer.setPixelRatio(this.quality ? 1 : 0.75);
        this.composer.setPixelRatio(this.quality ? 1 : 0.75);
        this.resize();
      }
      this.frames = 0;
      this.spent = 0;
    }
  };

  private print(at: THREE.Vector3, seat: number) {
    const f = this.prints[this.printAt = (this.printAt + 1) % this.prints.length];
    f.life = 1;
    f.m.visible = true;
    f.m.position.set(at.x + (this.printAt % 2 ? 0.22 : -0.22), 0.02, at.z);
    (f.m.material as THREE.MeshBasicMaterial).color.set(this.colors[seat]);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
