import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
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

const N = 6;
const seatPos = (i: number) => new THREE.Vector3((i - 2.5) * 2.15, 0, Math.pow(Math.abs(i - 2.5), 2) * 0.3 - 1.2);

type Bot = {
  root: THREE.Group; mixer: THREE.AnimationMixer; actions: Record<string, THREE.AnimationAction>; current: string;
  main: THREE.MeshStandardMaterial; face?: THREE.Mesh; desk: THREE.MeshStandardMaterial; ring: THREE.Mesh; spot: THREE.SpotLight;
  bars: THREE.Mesh[]; hold: boolean;
};

/// The trading floor: six robot traders at desks under a giant price wall.
export class Scene3D {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  private clock = new THREE.Clock();
  private bots: Bot[] = [];
  private wallCanvas = document.createElement("canvas");
  private wallTex: THREE.CanvasTexture;
  private wallMat: THREE.MeshBasicMaterial;
  private amb = new THREE.HemisphereLight(0x8fb4ff, 0x0b0e14, 0.9);
  private key = new THREE.DirectionalLight(0xffffff, 1.6);
  private alarm = new THREE.PointLight(0xff3030, 0, 60);
  private skyline: THREE.InstancedMesh;
  private view: View | null = null;
  private camPos = new THREE.Vector3(0, 2.5, 10.6);
  private camLook = new THREE.Vector3(0, 3.05, 0);
  private look = new THREE.Vector3(0, 3.05, 0);
  private shake = 0;
  private flash = 0;
  private flashColor = new THREE.Color();
  private raf = 0;
  private ray = new THREE.Raycaster();
  private disposed = false;
  ready = false;

  constructor(private host: HTMLElement, private colors: string[], private tags: () => (HTMLElement | null)[], private onPick: (seat: number) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x05070c);
    this.scene.fog = new THREE.Fog(0x05070c, 16, 46);

    this.key.position.set(4, 10, 8);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    Object.assign(this.key.shadow.camera, { left: -9, right: 9, top: 8, bottom: -4, near: 1, far: 30 });
    this.alarm.position.set(0, 6, 2);
    this.scene.add(this.amb, this.key, this.alarm);

    // Floor with a glowing grid.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ color: 0x0a0f18, roughness: 0.35, metalness: 0.6 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    const grid = new THREE.GridHelper(120, 80, 0x1f6f5b, 0x12303a);
    grid.position.y = 0.01;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    this.scene.add(floor, grid);

    // The price wall.
    this.wallCanvas.width = 1536;
    this.wallCanvas.height = 640;
    this.wallTex = new THREE.CanvasTexture(this.wallCanvas);
    this.wallTex.colorSpace = THREE.SRGBColorSpace;
    this.wallMat = new THREE.MeshBasicMaterial({ map: this.wallTex, toneMapped: false });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(13.9, 5.8), this.wallMat);
    wall.position.set(0, 5.3, -5.2);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(14.4, 6.3, 0.3), new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.4, metalness: 0.8 }));
    frame.position.set(0, 5.3, -5.38);
    for (const x of [-6.6, 6.6]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.35, 2.6, 0.35), frame.material);
      leg.position.set(x, 1.3, -5.38);
      this.scene.add(leg);
    }
    this.scene.add(wall, frame);

    // A skyline of candlesticks behind the wall.
    const count = 90;
    this.skyline = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), count);
    const m = new THREE.Object3D(), c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const h = 2 + Math.random() * 13, x = (i - count / 2) * 1.5 + Math.random();
      m.position.set(x, h / 2, -16 - Math.random() * 16);
      m.scale.set(0.8, h, 0.8);
      m.updateMatrix();
      this.skyline.setMatrixAt(i, m.matrix);
      this.skyline.setColorAt(i, c.set(Math.random() > 0.45 ? 0x0f6b4c : 0x7a1f2b).multiplyScalar(0.35 + Math.random() * 0.5));
    }
    this.scene.add(this.skyline);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.5, 0.9));
    this.composer.addPass(new OutputPass());

    this.resize();
    new ResizeObserver(() => this.resize()).observe(host);
    this.renderer.domElement.addEventListener("click", this.click);
    this.renderer.domElement.addEventListener("pointermove", this.hover);
    new GLTFLoader().load(`${import.meta.env.BASE_URL}robot.glb`, (g) => this.build(g.scene, g.animations));
    this.loop();
  }

  private build(model: THREE.Object3D, clips: THREE.AnimationClip[]) {
    if (this.disposed) return;
    const scale = 0.42;
    for (let i = 0; i < N; i++) {
      const root = new THREE.Group(), body = cloneSkinned(model), p = seatPos(i), col = new THREE.Color(this.colors[i]);
      body.scale.setScalar(scale);
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
      root.position.copy(p);
      root.rotation.y = -(i - 2.5) * 0.13;
      root.userData.seat = i;

      // Desk with a glowing top and a position meter.
      const desk = new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.22), emissive: col, emissiveIntensity: 0.08, roughness: 0.4, metalness: 0.5 });
      const console_ = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.9, 0.5), desk);
      console_.position.set(0, 0.45, 1.05);
      console_.castShadow = true;
      root.add(console_);
      const bars: THREE.Mesh[] = [];
      for (let k = 0; k < 10; k++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.04), new THREE.MeshBasicMaterial({ color: 0x1c2333, toneMapped: false }));
        bar.position.set((k - 4.5) * 0.13 + (k > 4 ? 0.03 : -0.03), 0.62, 1.31);
        root.add(bar);
        bars.push(bar);
      }
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.1, 48), new THREE.MeshBasicMaterial({ color: col, toneMapped: false, transparent: true, opacity: 0 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      root.add(ring);
      const spot = new THREE.SpotLight(col, 0, 14, 0.42, 0.6, 1.2);
      spot.position.set(p.x, 7, p.z + 2.2);
      spot.target = root;
      this.scene.add(root, spot);

      const mixer = new THREE.AnimationMixer(body), actions: Record<string, THREE.AnimationAction> = {};
      for (const clip of clips) actions[clip.name] = mixer.clipAction(clip);
      actions.Idle.time = Math.random() * 2;
      actions.Idle.play();
      const bot: Bot = { root, mixer, actions, current: "Idle", main, face, desk, ring, spot, bars, hold: false };
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
    if (prev !== next) next.crossFadeFrom(prev, 0.2, false);
    next.play();
    b.current = name;
  }

  private express(b: Bot, name: "Angry" | "Surprised" | "Sad" | null) {
    const d = b.face?.morphTargetDictionary, inf = b.face?.morphTargetInfluences;
    if (!d || !inf) return;
    for (const k of Object.keys(d)) inf[d[k]] = k === name ? 1 : 0;
  }

  /// A trader buys (cheers) or sells (slams).
  trade(seat: number, delta: number) {
    const b = this.bots[seat];
    if (!b || this.view?.stage !== "live") return;
    this.play(b, delta > 0 ? "ThumbsUp" : "Punch", true);
    b.desk.emissive.set(delta > 0 ? 0x3ddc97 : 0xff6b6b);
    b.desk.emissiveIntensity = 1.6;
  }

  /// A news shock hits the floor.
  news(bps: number) {
    this.shake = 0.5;
    this.flash = 1;
    this.flashColor.set(bps > 0 ? 0x3ddc97 : 0xff4d4d);
    this.bots.forEach((b, i) => {
      if (this.view?.seats[i]?.empty) return;
      const helped = Math.sign(this.view!.seats[i].pos) === Math.sign(bps);
      setTimeout(() => { this.play(b, this.view!.seats[i].pos === 0 ? "Jump" : helped ? "Yes" : "No", true); this.express(b, helped ? null : "Surprised"); }, i * 60);
    });
  }

  set(v: View) {
    const prev = this.view;
    this.view = v;
    if (!this.ready) return;
    const changed = prev?.stage !== v.stage;
    this.bots.forEach((b, i) => {
      const s = v.seats[i];
      b.root.visible = true;
      b.root.children[0].visible = !s.empty;
      const col = new THREE.Color(this.colors[i]);
      b.bars.forEach((bar, k) => {
        const lvl = k < 5 ? k - 5 : k - 4, on = !s.empty && ((lvl > 0 && s.pos >= lvl) || (lvl < 0 && s.pos <= lvl));
        (bar.material as THREE.MeshBasicMaterial).color.set(on ? (lvl > 0 ? 0x3ddc97 : 0xff6b6b) : 0x1c2333);
      });
      (b.ring.material as THREE.MeshBasicMaterial).opacity = i === v.me ? 0.9 : 0;
      (b.ring.material as THREE.MeshBasicMaterial).color.set(i === v.me && v.insiderMe ? 0xf5b83d : col);
      if (changed || prev?.seats[i].empty !== s.empty) {
        b.main.color.copy(col);
        b.main.emissive.set(0);
        this.express(b, null);
        if (v.stage === "idle") this.play(b, "Idle");
        if (v.stage === "deal") this.play(b, "Standing", true);
        if (v.stage === "live") this.play(b, "Idle");
        if (v.stage === "vote") this.play(b, "Idle");
        if (v.stage === "drum") { this.play(b, "Idle"); this.express(b, "Surprised"); }
        if (v.stage === "reveal") {
          if (i === v.insider) {
            b.main.color.set(0x15171c);
            b.main.emissive.set(v.caught ? 0x550000 : 0x4a3500);
            this.express(b, v.caught ? "Sad" : "Angry");
            v.caught ? this.play(b, "Death", true, true) : this.play(b, "Dance");
          } else {
            this.express(b, v.caught ? null : "Sad");
            setTimeout(() => this.view?.stage === "reveal" && this.play(b, v.caught ? "Jump" : "No", true), 300 + i * 90);
          }
        }
      } else if (v.stage === "live" && b.current === "Idle") this.express(b, s.mood < 0 ? "Sad" : null);
    });
    // Camera and lighting per stage.
    const a = Math.max(1, 1.55 / this.camera.aspect);
    if (v.stage === "vote" || v.stage === "drum") { this.camPos.set(0, 2.2, 8.6 * a); this.camLook.set(0, 1.5, 0); }
    else if (v.stage === "reveal" && this.bots[v.insider]) { const p = seatPos(v.insider); this.camPos.set(p.x * 0.75, 1.9, p.z + 5.2 * a); this.camLook.set(p.x, 1.25, p.z); }
    else { this.camPos.set(0, 2.5, 10.6 * a); this.camLook.set(0, 3.05, 0); }
    this.drawWall(v.wall);
  }

  private drawWall(w: Wall) {
    const c = this.wallCanvas.getContext("2d")!, W = this.wallCanvas.width, H = this.wallCanvas.height;
    c.fillStyle = "#070b12";
    c.fillRect(0, 0, W, H);
    const up = w.price >= w.open, usd = (p: number) => (p / 1e8).toFixed(2);
    c.textBaseline = "top";
    c.font = "800 84px Inter, system-ui, sans-serif";
    c.fillStyle = "#fff";
    c.fillText(w.price ? `$${usd(w.price)}` : "—", 40, 28);
    const pw = c.measureText(w.price ? `$${usd(w.price)}` : "—").width;
    if (w.open && w.price) {
      c.font = "700 40px Inter, system-ui, sans-serif";
      c.fillStyle = up ? "#3ddc97" : "#ff6b6b";
      c.fillText(`${up ? "▲" : "▼"} ${Math.abs(((w.price - w.open) / w.open) * 100).toFixed(2)}%`, 70 + pw, 62);
    }
    c.font = "600 26px Inter, system-ui, sans-serif";
    c.fillStyle = "#6b7a99";
    c.textAlign = "right";
    c.fillText(`SOL / USD · ROUND ${w.round}`, W - 40, 34);
    c.textAlign = "left";
    const x0 = 50, x1 = W - 110, y0 = 150, y1 = H - 60, X = (t: number) => x0 + (t / 60) * (x1 - x0);
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
    if (w.title) {
      c.fillStyle = "rgba(5,7,12,.86)";
      c.fillRect(0, 0, W, H);
      c.textAlign = "center";
      c.fillStyle = "#fff";
      c.font = "800 96px Inter, system-ui, sans-serif";
      c.fillText(w.title, W / 2, H / 2 - 90);
      c.fillStyle = "#8fa0c2";
      c.font = "600 38px Inter, system-ui, sans-serif";
      c.fillText(w.sub, W / 2, H / 2 + 40);
      c.textAlign = "left";
    }
    this.wallTex.needsUpdate = true;
  }

  private pick(e: PointerEvent | MouseEvent): number {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hit = this.ray.intersectObjects(this.bots.map((b) => b.root), true)[0];
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && o.userData.seat === undefined) o = o.parent;
    return o ? (o.userData.seat as number) : -1;
  }
  private click = (e: MouseEvent) => { const s = this.pick(e); if (s >= 0 && this.view?.stage === "vote" && s !== this.view.me && !this.view.seats[s].empty) this.onPick(s); };
  private hover = (e: PointerEvent) => {
    const s = this.view?.stage === "vote" ? this.pick(e) : -1;
    this.renderer.domElement.style.cursor = s >= 0 && s !== this.view!.me ? "pointer" : "";
  };

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.view) this.set(this.view);
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05), t = this.clock.elapsedTime, v = this.view;
    const stage = v?.stage ?? "idle";
    const k = 1 - Math.exp(-dt * 2.6);
    this.camera.position.lerp(this.camPos, k);
    this.look.lerp(this.camLook, k);
    this.camera.position.x += Math.sin(t * 0.25) * 0.004;
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.5;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.5;
    }
    this.camera.lookAt(this.look);
    this.flash = Math.max(0, this.flash - dt * 0.9);
    const dark = stage === "vote" || stage === "drum" || stage === "reveal";
    this.amb.intensity += ((dark ? 0.18 : 0.9) - this.amb.intensity) * k;
    this.key.intensity += ((dark ? 0.25 : 1.6) - this.key.intensity) * k;
    this.alarm.color.copy(this.flash > 0 ? this.flashColor : new THREE.Color(0xff3030));
    this.alarm.intensity = this.flash * 260 + (stage === "drum" ? (Math.sin(t * 14) > 0 ? 90 : 0) : 0);
    this.wallMat.color.setScalar(dark ? 0.45 : 1).lerp(this.flashColor, this.flash * 0.5);
    this.bots.forEach((b, i) => {
      b.mixer.update(dt);
      b.desk.emissive.lerp(new THREE.Color(this.colors[i]), dt * 3);
      b.desk.emissiveIntensity += (0.08 - b.desk.emissiveIntensity) * dt * 3;
      const lit = stage === "vote" ? 60 : stage === "drum" ? (Math.floor(t * 9) % N === i ? 120 : 6) : stage === "reveal" ? (i === v!.insider ? 160 : 4) : 0;
      b.spot.intensity += (lit - b.spot.intensity) * Math.min(1, dt * 8);
      if (stage === "reveal" && i === v!.insider) b.spot.color.set(v!.caught ? 0xff3b3b : 0xf5b83d); else b.spot.color.set(this.colors[i]);
      (b.ring.material as THREE.MeshBasicMaterial).opacity *= i === v?.me ? 1 : 0;
      b.ring.scale.setScalar(1 + Math.sin(t * 3) * 0.04);
      // Pin the HTML tag above the trader's head.
      const el = this.tags()[i];
      if (el) {
        const p = b.root.position.clone().setY(2.2).project(this.camera);
        el.style.transform = `translate(-50%,-100%) translate(${((p.x + 1) / 2) * this.host.clientWidth}px,${((1 - p.y) / 2) * this.host.clientHeight}px)`;
        el.style.opacity = p.z < 1 ? "1" : "0";
      }
    });
    this.composer.render();
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
