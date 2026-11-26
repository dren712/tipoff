import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

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
export type View = { stage: Stage; seats: SeatView[]; me: number; insiderMe: boolean; insider: number; caught: boolean; canVote?: boolean; wall: Wall };

const N = 6, TILE = 1.6, GREEN = 0x3ddc97, RED = 0xff5c6c, MAGENTA = 0xff3df0, GOLD = 0xf5b83d;
const SEAT_NAMES = ["RUBY", "AMBER", "RUSTY", "JADE", "AZURE", "VIOLET"];
const laneX = (i: number) => (i - 2.5) * 2;
const VAULT = new THREE.Vector3(-8.5, 4.6, -9.5);
const AUDIENCE_MAX = 144;

type Bot = {
  root: THREE.Group; body: THREE.Object3D; mixer: THREE.AnimationMixer; actions: Record<string, THREE.AnimationAction>; current: string;
  main: THREE.MeshStandardMaterial; face?: THREE.Mesh; ring: THREE.Mesh; pulse: THREE.Mesh; spot: THREE.SpotLight; beam: THREE.Mesh;
  hold: boolean; moving: boolean; down: number; yaw: number; trail: number;
};
type Coin = { p: THREE.Vector3; v: THREE.Vector3; life: number };
type MovingBeam = { pivot: THREE.Group; cone: THREE.Mesh; mat: THREE.MeshBasicMaterial; spot?: THREE.SpotLight; base: THREE.Vector3 };

function label(text: string, color: string, w = 512, h = 128) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  g.font = `900 ${h * 0.7}px Inter, system-ui, sans-serif`;
  g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = color;
  g.fillText(text, w / 2, h / 2 + 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: t, transparent: true, toneMapped: false, side: THREE.DoubleSide });
}

function createBrushedNormalMap(): THREE.CanvasTexture {
  const size = 256;
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const streak = (Math.sin(y * 1.7) * 0.35 + Math.random() * 0.65);
    for (let x = 0; x < size; x++) {
      const n = Math.sin(x * 0.14 + y * 0.05) * 0.2 + streak * 0.55 + Math.random() * 0.25;
      h[y * size + x] = n;
    }
  }
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const g = c.getContext("2d")!;
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x];
      const d = h[((y + 1) % size) * size + x];
      const dx = (l - r) * 1.1, dy = (u - d) * 2.4;
      const len = Math.hypot(dx, dy, 1);
      const idx = (y * size + x) * 4;
      img.data[idx] = Math.round(((dx / len) * 0.5 + 0.5) * 255);
      img.data[idx + 1] = Math.round(((dy / len) * 0.5 + 0.5) * 255);
      img.data[idx + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      img.data[idx + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 6);
  return tex;
}

function createChevronTexture(hex: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = hex;
  g.lineWidth = 12;
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const y of [38, 98]) {
    g.beginPath();
    g.moveTo(24, y + 20);
    g.lineTo(64, y - 12);
    g.lineTo(104, y + 20);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 5);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createPadlockTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(18, 6, 26, 0.9)";
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = "#ff5af5";
  g.lineWidth = 8;
  g.strokeRect(10, 10, 236, 236);
  g.strokeStyle = "#ff8af7";
  g.lineWidth = 16;
  g.beginPath();
  g.arc(128, 102, 36, Math.PI, 0);
  g.stroke();
  g.fillStyle = "#ff3df0";
  g.beginPath();
  g.roundRect(74, 106, 108, 84, 14);
  g.fill();
  g.fillStyle = "#12061a";
  g.beginPath();
  g.arc(128, 142, 12, 0, Math.PI * 2);
  g.fill();
  g.fillRect(122, 148, 12, 24);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createBeveledTileGeo(w: number, h: number, bevel = 0.032): THREE.BufferGeometry {
  const hw = w / 2 - bevel, hh = h / 2 - bevel;
  const s = new THREE.Shape();
  s.moveTo(-hw, -hh);
  s.lineTo(hw, -hh);
  s.lineTo(hw, hh);
  s.lineTo(-hw, hh);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.015,
    bevelEnabled: true,
    bevelThickness: 0.022,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 1,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function createFresnelTileMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: false,
    toneMapped: false,
    vertexShader: `
      varying vec3 vNormalV;
      varying vec3 vViewV;
      varying vec3 vInstCol;
      void main() {
        #ifdef USE_INSTANCING_COLOR
          vInstCol = instanceColor;
        #else
          vInstCol = vec3(0.2);
        #endif
        mat4 m = modelMatrix;
        #ifdef USE_INSTANCING
          m = modelMatrix * instanceMatrix;
        #endif
        vec4 worldPos = m * vec4(position, 1.0);
        vec3 worldN = normalize(mat3(m) * normal);
        vNormalV = normalize((viewMatrix * vec4(worldN, 0.0)).xyz);
        vec4 mvPos = viewMatrix * worldPos;
        vViewV = normalize(-mvPos.xyz);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      varying vec3 vNormalV;
      varying vec3 vViewV;
      varying vec3 vInstCol;
      void main() {
        float ndv = clamp(abs(dot(normalize(vNormalV), normalize(vViewV))), 0.0, 1.0);
        float fresnel = pow(1.0 - ndv, 2.1);
        float sideMask = 1.0 - smoothstep(0.65, 0.96, abs(vNormalV.y));
        vec3 base = vInstCol * 0.72 + vec3(0.015, 0.022, 0.055);
        vec3 edgeGlow = (vInstCol * 1.45 + vec3(0.1, 0.14, 0.28)) * (fresnel * 0.95 + sideMask * 0.65);
        gl_FragColor = vec4(base + edgeGlow, 1.0);
      }
    `,
  });
}

function mergeParts(geos: THREE.BufferGeometry[], keepUv = false): THREE.BufferGeometry {
  const clean = geos.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g.clone();
    for (const k of Object.keys(ng.attributes)) {
      if (k !== "position" && k !== "normal" && !(keepUv && k === "uv") && k !== "skinIndex" && k !== "skinWeight") {
        ng.deleteAttribute(k);
      }
    }
    return ng;
  });
  return mergeGeometries(clean, false);
}

function placed(geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const g = geo.clone();
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

function optimizeBot(body: THREE.Object3D, col: THREE.Color) {
  body.updateMatrixWorld(true);
  let baseSkin: THREE.SkinnedMesh | undefined;
  body.traverse((o) => { if (!baseSkin && (o as THREE.SkinnedMesh).isSkinnedMesh) baseSkin = o as THREE.SkinnedMesh; });
  let main!: THREE.MeshStandardMaterial, face: THREE.Mesh | undefined;
  const buckets = new Map<string, { mat: THREE.MeshStandardMaterial; geos: THREE.BufferGeometry[] }>();
  const toRemove: THREE.Object3D[] = [];
  const invBind = baseSkin ? baseSkin.bindMatrixInverse.clone() : new THREE.Matrix4();

  body.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
    if (mat.name === "Main") { mat.color.copy(col); main ??= mat; mesh.material = main; } else mesh.material = mat;
    if (mesh.morphTargetDictionary) {
      face = mesh;
      mesh.castShadow = false;
      return;
    }
    if (!baseSkin) {
      mesh.castShadow = mat.name === "Main";
      return;
    }
    let g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    for (const k of Object.keys(g.attributes)) {
      if (k !== "position" && k !== "normal" && k !== "skinIndex" && k !== "skinWeight") g.deleteAttribute(k);
    }
    const count = g.attributes.position.count;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      const sm = mesh as THREE.SkinnedMesh;
      const si = g.attributes.skinIndex as THREE.BufferAttribute;
      const sw = g.attributes.skinWeight as THREE.BufferAttribute;
      const idxArr = new Uint16Array(count * 4);
      const wArr = new Float32Array(count * 4);
      for (let v = 0; v < count; v++) {
        for (let k = 0; k < 4; k++) {
          const b = sm.skeleton.bones[si.getComponent(v, k)];
          const mapped = b ? baseSkin.skeleton.bones.indexOf(b) : 0;
          idxArr[v * 4 + k] = mapped >= 0 ? mapped : 0;
          wArr[v * 4 + k] = sw.getComponent(v, k);
        }
      }
      g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(idxArr, 4));
      g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(wArr, 4));
    } else {
      let p: THREE.Object3D | null = mesh.parent;
      while (p && !(p as THREE.Bone).isBone) p = p.parent;
      const boneIdx = Math.max(0, p ? baseSkin.skeleton.bones.indexOf(p as THREE.Bone) : 0);
      g.applyMatrix4(invBind.clone().multiply(mesh.matrixWorld));
      const idxArr = new Uint16Array(count * 4);
      const wArr = new Float32Array(count * 4);
      for (let v = 0; v < count; v++) { idxArr[v * 4] = boneIdx; wArr[v * 4] = 1; }
      g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(idxArr, 4));
      g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(wArr, 4));
    }
    const key = mat.name || "Other";
    if (!buckets.has(key)) buckets.set(key, { mat: mat.name === "Main" ? main : mat, geos: [] });
    buckets.get(key)!.geos.push(g);
    toRemove.push(mesh);
  });

  if (baseSkin && baseSkin.parent) {
    const parent = baseSkin.parent;
    const skel = baseSkin.skeleton;
    const bindMat = baseSkin.bindMatrix.clone();
    for (const o of toRemove) o.parent?.remove(o);
    for (const [key, { mat, geos }] of buckets) {
      const merged = mergeParts(geos);
      const sm = new THREE.SkinnedMesh(merged, mat);
      sm.frustumCulled = false;
      sm.castShadow = key === "Main";
      parent.add(sm);
      sm.bind(skel, bindMat);
    }
  }
  return { main, face };
}

function createSkyDome(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(140, 24, 14);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x060a1e) },
      uHorizon: { value: new THREE.Color(0x1b275c) },
      uBottom: { value: new THREE.Color(0x040612) },
      uAccent: { value: new THREE.Color(0x2d174d) },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vWorldPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform vec3 uBottom;
      uniform vec3 uAccent;
      varying vec3 vWorldPos;
      void main() {
        vec3 dir = normalize(vWorldPos);
        float h = dir.y;
        float horizonBand = exp(-pow(h * 4.2, 2.0));
        vec3 col = h >= 0.0
          ? mix(uHorizon, uTop, smoothstep(0.0, 0.65, h))
          : mix(uHorizon, uBottom, smoothstep(0.0, 0.45, -h));
        float vaultGlow = pow(max(0.0, dot(normalize(dir.xz), normalize(vec2(-0.7, -0.7)))), 3.0) * horizonBand;
        col = mix(col, uAccent, vaultGlow * 0.45);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  return new THREE.Mesh(geo, mat);
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
  private deckMat: THREE.MeshStandardMaterial;
  private brushedNormal: THREE.CanvasTexture;
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
  private longGateMat!: THREE.MeshStandardMaterial;
  private shortGateMat!: THREE.MeshStandardMaterial;
  private longChevMat!: THREE.MeshBasicMaterial;
  private shortChevMat!: THREE.MeshBasicMaterial;
  private longChevTex!: THREE.CanvasTexture;
  private shortChevTex!: THREE.CanvasTexture;
  private vault = new THREE.Group();
  private vaultCore!: THREE.Mesh;
  private vaultRings: THREE.Mesh[] = [];
  private vaultEdgeMat!: THREE.LineBasicMaterial;
  private vaultLight = new THREE.PointLight(MAGENTA, 10, 18);
  private audience!: THREE.InstancedMesh;
  private audienceColors: THREE.Color[] = [];
  private audienceTimer = 0;
  private pitInner!: THREE.InstancedMesh;
  private pitOuter!: THREE.InstancedMesh;
  private beams: MovingBeam[] = [];
  private beamShadows: THREE.SpotLight[] = [];
  private wallCanvas = document.createElement("canvas");
  private wallTex: THREE.CanvasTexture;
  private wallMat: THREE.MeshBasicMaterial;
  private tickerCanvas = document.createElement("canvas");
  private tickerTex: THREE.CanvasTexture;
  private tickerOffset = 0;
  private tickerDrawAt = 0;
  private tickerText = "TIPOFF EXCHANGE  •  SEALED PRIVATE ROLLUP  •  NO WALLET  •  NO FEES";
  private amb = new THREE.HemisphereLight(0x4b62b8, 0xc88a28, 0.65);
  private key = new THREE.DirectionalLight(0xffe2c0, 1.35);
  private rim = new THREE.DirectionalLight(0x7fc4ff, 1.35);
  private edgeFillL = new THREE.PointLight(GOLD, 3.2, 20);
  private edgeFillR = new THREE.PointLight(GOLD, 3.2, 20);
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
  private reducedMotion = false;
  private motionMq: MediaQueryList | null = null;
  private onMotion = (e: MediaQueryListEvent) => { this.reducedMotion = e.matches; };
  private tmp = new THREE.Object3D();
  private col = new THREE.Color();
  ready = false;
  /// Lobby backdrop: circle the floor instead of framing a seat.
  orbit = false;

  constructor(private host: HTMLElement, private colors: string[], private tags: () => (HTMLElement | null)[], private onPick: (seat: number) => void) {
    this.motionMq = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    this.reducedMotion = this.motionMq?.matches ?? false;
    this.motionMq?.addEventListener?.("change", this.onMotion);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.info.autoReset = false;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x060a1e);
    this.scene.fog = new THREE.FogExp2(0x0a1029, 0.011);
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.4;
    this.scene.add(createSkyDome());

    // Three-point lighting + low gold deck-edge fills + event alarm.
    this.key.position.set(7, 14, 9);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    Object.assign(this.key.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 45 });
    this.rim.position.set(-5, 9, -15);
    this.edgeFillL.position.set(-7.6, 0.8, 0);
    this.edgeFillR.position.set(7.6, 0.8, 0);
    this.alarm.position.set(0, 9, 0);
    this.scene.add(this.amb, this.key, this.rim, this.edgeFillL, this.edgeFillR, this.alarm, this.deck, this.spotL);

    // The deck: brushed-metal slab with glass-edge trim strips and beveled Fresnel lane tiles.
    this.brushedNormal = createBrushedNormalMap();
    this.deckMat = new THREE.MeshStandardMaterial({
      color: 0x10172b, roughness: 0.34, metalness: 0.86,
      normalMap: this.brushedNormal, normalScale: new THREE.Vector2(0.4, 0.4),
    });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x0b1020, roughness: 0.4, metalness: 0.82 });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(12.6, 0.5, 19), this.deckMat);
    slab.position.y = -0.26;
    slab.receiveShadow = true;
    this.deck.add(slab);

    const glassTrim = new THREE.MeshStandardMaterial({
      color: 0x3b82ff, emissive: 0x1e40af, emissiveIntensity: 0.9, roughness: 0.12, metalness: 0.2,
      transparent: true, opacity: 0.65,
    });
    const edgeCore = new THREE.MeshBasicMaterial({ color: 0x5aa2ff, toneMapped: false });
    const goldEdge = new THREE.MeshBasicMaterial({ color: GOLD, toneMapped: false });
    const glassGeos: THREE.BufferGeometry[] = [];
    const coreGeos: THREE.BufferGeometry[] = [];
    const goldDeckGeos: THREE.BufferGeometry[] = [];
    for (const x of [-6.36, 6.36]) {
      glassGeos.push(placed(new THREE.BoxGeometry(0.18, 0.16, 19.1), x, 0.04, 0));
      coreGeos.push(placed(new THREE.BoxGeometry(0.05, 0.05, 19), x, 0.04, 0));
    }
    for (const z of [-9.55, 9.55]) {
      goldDeckGeos.push(placed(new THREE.BoxGeometry(12.9, 0.08, 0.1), 0, 0.02, z));
    }
    const divMat = new THREE.MeshBasicMaterial({ color: 0x26386e });
    const divGeos: THREE.BufferGeometry[] = [];
    for (let i = 1; i < N; i++) {
      divGeos.push(placed(new THREE.BoxGeometry(0.035, 0.02, 18.4), laneX(i) - 1, 0.011, 0));
    }
    this.deck.add(
      new THREE.Mesh(mergeParts(glassGeos), glassTrim),
      new THREE.Mesh(mergeParts(coreGeos), edgeCore),
      new THREE.Mesh(mergeParts(goldDeckGeos), goldEdge),
      new THREE.Mesh(mergeParts(divGeos), divMat),
    );

    const tileGeo = createBeveledTileGeo(1.78, 1.4, 0.032);
    this.tiles = new THREE.InstancedMesh(tileGeo, createFresnelTileMaterial(), N * 11);
    for (let i = 0; i < N; i++) for (let p = -5; p <= 5; p++) {
      this.tmp.position.set(laneX(i), 0.008, -p * TILE); this.tmp.rotation.set(0, 0, 0); this.tmp.scale.setScalar(1); this.tmp.updateMatrix();
      this.tiles.setMatrixAt(i * 11 + p + 5, this.tmp.matrix);
      this.tiles.setColorAt(i * 11 + p + 5, this.col.set(0));
    }
    this.deck.add(this.tiles);

    // Gates: lit arches at LONG (far) and SHORT (near) with animated floor chevron lanes.
    this.longChevTex = createChevronTexture("#3ddc97");
    this.shortChevTex = createChevronTexture("#ff5c6c");
    this.longChevMat = new THREE.MeshBasicMaterial({ map: this.longChevTex, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.shortChevMat = new THREE.MeshBasicMaterial({ map: this.shortChevTex, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });

    const darkMetalGeos: THREE.BufferGeometry[] = [];
    const buildGate = (z: number, hex: number, text: string, near: boolean) => {
      const m = new THREE.MeshStandardMaterial({ color: 0x070a14, emissive: hex, emissiveIntensity: 1.5, roughness: 0.4, metalness: 0.6 });
      if (near) this.shortGateMat = m; else this.longGateMat = m;
      const g = near ? this.nearGate : this.deck;
      const ph = near ? 1.3 : 3.2;
      const gateGeos: THREE.BufferGeometry[] = [];
      for (const x of [-6.15, 6.15]) {
        gateGeos.push(placed(new THREE.BoxGeometry(0.34, ph, 0.34), x, ph / 2, z));
        if (near) g.add(new THREE.Mesh(placed(new THREE.BoxGeometry(0.48, 0.2, 0.48), x, 0.1, z), frameMat));
        else darkMetalGeos.push(placed(new THREE.BoxGeometry(0.48, 0.2, 0.48), x, ph, z));
      }
      if (!near) {
        gateGeos.push(placed(new THREE.BoxGeometry(12.6, 0.32, 0.32), 0, ph, z));
        const archTrim = new THREE.Mesh(new THREE.BoxGeometry(11.8, 0.08, 0.38), new THREE.MeshBasicMaterial({ color: hex, toneMapped: false }));
        archTrim.position.set(0, ph - 0.22, z);
        g.add(archTrim);
      } else {
        for (const s of [-1, 1]) gateGeos.push(placed(new THREE.BoxGeometry(2.1, 0.24, 0.28), s * 5.2, ph, z));
        gateGeos.push(placed(new THREE.BoxGeometry(12.6, 0.09, 0.28), 0, 0.045, z));
      }
      g.add(new THREE.Mesh(mergeParts(gateGeos), m));
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.0, 0.9), label(text, "#" + new THREE.Color(hex).getHexString()));
      if (near) { sign.rotation.x = -Math.PI / 2; sign.position.set(0, 0.035, 8.75); sign.scale.setScalar(0.8); }
      else sign.position.set(0, 3.65, z);
      g.add(sign);

      const runner = new THREE.Mesh(new THREE.PlaneGeometry(11.4, 7.2).rotateX(-Math.PI / 2), near ? this.shortChevMat : this.longChevMat);
      runner.position.set(0, 0.018, near ? 5.2 : -5.2);
      if (near) runner.rotation.y = Math.PI;
      g.add(runner);
    };
    buildGate(-9.6, GREEN, "LONG", false);
    buildGate(9.6, RED, "SHORT", true);

    darkMetalGeos.push(placed(new THREE.CylinderGeometry(1.1, 2.4, 13, 8), 0, -7, 0));

    // Arena shell: three stepped horseshoe tiers (merged into static tier & trim calls).
    const tierMat = new THREE.MeshStandardMaterial({ color: 0x0b1024, roughness: 0.65, metalness: 0.45, side: THREE.DoubleSide });
    const trimMat = new THREE.MeshBasicMaterial({ color: 0x2b4594, toneMapped: false });
    const goldTrimMat = new THREE.MeshBasicMaterial({ color: GOLD, toneMapped: false });
    const arcLen = Math.PI * 1.44;
    const arcStart = Math.PI - arcLen / 2;
    const tierRadii = [17.8, 22.6, 27.6];
    const tierYs = [-5.8, -3.5, -1.2];
    const tierGeos: THREE.BufferGeometry[] = [];
    const trimGeos: THREE.BufferGeometry[] = [];
    const goldArenaGeos: THREE.BufferGeometry[] = [];
    for (let t = 0; t < 3; t++) {
      const rIn = tierRadii[t], rOut = rIn + 4.4, y = tierYs[t];
      tierGeos.push(placed(new THREE.CylinderGeometry(rIn, rIn, 2.2, 28, 1, true, arcStart, arcLen), 0, y - 1.1, 0));
      tierGeos.push(placed(new THREE.RingGeometry(rIn, rOut, 28, 1, 0, arcLen).rotateX(-Math.PI / 2), 0, y, 0, 0, Math.PI / 2 - arcLen / 2 + Math.PI, 0));
      const railGeo = placed(new THREE.TorusGeometry(rIn + 0.08, 0.06, 6, 32, arcLen).rotateX(Math.PI / 2), 0, y + 0.05, 0, 0, -Math.PI / 2 - arcLen / 2, 0);
      if (t === 2) goldArenaGeos.push(railGeo); else trimGeos.push(railGeo);
    }
    this.scene.add(new THREE.Mesh(mergeParts(tierGeos), tierMat), new THREE.Mesh(mergeParts(trimGeos), trimMat));

    // Audience terminals: 144 glowing emissive monitors across the 3 stepped tiers (single InstancedMesh draw call).
    this.audience = new THREE.InstancedMesh(new THREE.BoxGeometry(0.85, 0.5, 0.14), new THREE.MeshBasicMaterial({ toneMapped: false }), AUDIENCE_MAX);
    const deskPalette = [0x3b82f6, 0x3ddc97, 0xf5b83d, 0x7fd6ff, 0xa78bfa];
    for (let i = 0; i < AUDIENCE_MAX; i++) {
      const tier = i % 3;
      const idxInTier = Math.floor(i / 3);
      const frac = (idxInTier + 0.5) / (AUDIENCE_MAX / 3);
      const ang = -Math.PI * 0.7 + frac * Math.PI * 1.4; // -126..+126 deg around -Z
      const r = tierRadii[tier] + 2.2;
      const x = Math.sin(ang) * r, z = -Math.cos(ang) * r, y = tierYs[tier] + 0.55;
      this.tmp.position.set(x, y, z);
      this.tmp.lookAt(0, 1.5, 0);
      this.tmp.scale.setScalar(1);
      this.tmp.updateMatrix();
      this.audience.setMatrixAt(i, this.tmp.matrix);
      const baseCol = new THREE.Color(deskPalette[i % deskPalette.length]).multiplyScalar(0.55 + Math.random() * 0.5);
      this.audienceColors.push(baseCol);
      this.audience.setColorAt(i, baseCol);
    }
    this.scene.add(this.audience);

    // Overhead truss ring, cross-bridge over the jumbotron, and 4 moving-head spotlight fixtures.
    const trussY = 10.15;
    const trussMat = new THREE.MeshStandardMaterial({ color: 0x1a2342, roughness: 0.42, metalness: 0.85 });
    darkMetalGeos.push(
      placed(new THREE.TorusGeometry(15.2, 0.16, 6, 32).rotateX(Math.PI / 2), 0, trussY, 0),
      placed(new THREE.TorusGeometry(14.1, 0.13, 6, 32).rotateX(Math.PI / 2), 0, trussY - 0.55, 0),
      placed(new THREE.BoxGeometry(18.5, 0.22, 0.28), 0, trussY - 0.55, -10.8),
    );
    goldArenaGeos.push(
      placed(new THREE.TorusGeometry(14.65, 0.045, 6, 32).rotateX(Math.PI / 2), 0, trussY - 0.3, 0),
      placed(new THREE.BoxGeometry(18.5, 0.05, 0.32), 0, trussY - 0.68, -10.8),
    );

    const strutCount = 24;
    const strutGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.25, 6);
    for (let i = 0; i < strutCount; i++) {
      const a = (i / strutCount) * Math.PI * 2;
      darkMetalGeos.push(placed(strutGeo, Math.sin(a) * 14.65, trussY - 0.28, Math.cos(a) * 14.65, 0, -a, 0.55));
    }

    const headGeo = new THREE.CylinderGeometry(0.28, 0.36, 0.6, 10);
    const beamConeGeo = new THREE.CylinderGeometry(0.12, 2.3, 18, 14, 1, true).translate(0, -9, 0);
    const beamPos = [
      new THREE.Vector3(-6.2, trussY - 0.85, -10.8),
      new THREE.Vector3(6.2, trussY - 0.85, -10.8),
      new THREE.Vector3(-10.6, trussY - 0.55, 3.6),
      new THREE.Vector3(10.6, trussY - 0.55, 3.6),
    ];
    beamPos.forEach((bp, idx) => {
      const pivotG = new THREE.Group();
      pivotG.position.copy(bp);
      const pod = new THREE.Mesh(headGeo, trussMat);
      const mat = new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      const cone = new THREE.Mesh(beamConeGeo, mat);
      pivotG.add(pod, cone);
      this.scene.add(pivotG);
      let spot: THREE.SpotLight | undefined;
      if (idx === 0) {
        spot = new THREE.SpotLight(GOLD, 42, 36, 0.42, 0.7, 1.0);
        spot.position.copy(bp);
        spot.castShadow = true;
        spot.shadow.mapSize.set(512, 512);
        this.scene.add(spot, spot.target);
        this.beamShadows.push(spot);
      }
      this.beams.push({ pivot: pivotG, cone, mat, spot, base: bp });
    });

    // The pit below, and two parallax rings of slow-moving candle-chart columns.
    const pit = new THREE.GridHelper(260, 130, 0x2b3cff, 0x121a44);
    pit.position.y = -13;
    this.scene.add(pit);
    const makePitLayer = (count: number, rMin: number, rSpan: number, hMin: number, hSpan: number, colScale: number) => {
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), count);
      for (let i = 0; i < count; i++) {
        // Keep columns out of the +Z front portrait camera tunnel.
        const frac = (i + 0.5) / count;
        const a = -Math.PI * 0.78 + frac * Math.PI * 1.56;
        const r = rMin + Math.random() * rSpan, h = hMin + Math.random() * hSpan;
        this.tmp.position.set(Math.sin(a) * r, -13 + h / 2, -Math.cos(a) * r);
        this.tmp.rotation.set(0, a, 0);
        this.tmp.scale.set(1.4, h, 1.4);
        this.tmp.updateMatrix();
        mesh.setMatrixAt(i, this.tmp.matrix);
        mesh.setColorAt(i, this.col.set(Math.random() > 0.45 ? 0x138862 : 0x992638).multiplyScalar(colScale + Math.random() * 0.3));
      }
      this.scene.add(mesh);
      return mesh;
    };
    this.pitInner = makePitLayer(76, 30, 12, 8, 18, 0.32);
    this.pitOuter = makePitLayer(84, 46, 22, 14, 28, 0.22);

    // The jumbotron: physical bezel, CRT scan-lines, and separate scrolling trade ticker strip below.
    this.wallCanvas.width = 1536;
    this.wallCanvas.height = 672;
    this.wallTex = new THREE.CanvasTexture(this.wallCanvas);
    this.wallTex.colorSpace = THREE.SRGBColorSpace;
    this.wallMat = new THREE.MeshBasicMaterial({ map: this.wallTex, toneMapped: false });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(13.6, 5.2), this.wallMat);
    wall.position.set(0, 7.65, -12.6);
    darkMetalGeos.push(placed(new THREE.BoxGeometry(14.4, 6.15, 0.52), 0, 7.35, -12.92));
    goldArenaGeos.push(placed(new THREE.BoxGeometry(14.5, 0.09, 0.56), 0, 10.42, -12.9));
    for (const sx of [-5.8, 5.8]) darkMetalGeos.push(placed(new THREE.CylinderGeometry(0.11, 0.11, 2.4, 6), sx, 9.6, -12.92));
    this.scene.add(new THREE.Mesh(mergeParts(darkMetalGeos), frameMat), new THREE.Mesh(mergeParts(goldArenaGeos), goldTrimMat));
    this.tickerCanvas.width = 1024;
    this.tickerCanvas.height = 56;
    this.tickerTex = new THREE.CanvasTexture(this.tickerCanvas);
    this.tickerTex.colorSpace = THREE.SRGBColorSpace;
    const tickerMesh = new THREE.Mesh(new THREE.PlaneGeometry(13.6, 0.66), new THREE.MeshBasicMaterial({ map: this.tickerTex, toneMapped: false }));
    tickerMesh.position.set(0, 4.72, -12.56);
    this.scene.add(wall, tickerMesh);

    // The Vault: the TEE set piece — black cube, rotating magenta cage rings, padlock glyph, and PRIVATE ROLLUP label.
    const cube = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), new THREE.MeshStandardMaterial({ color: 0x05030a, roughness: 0.14, metalness: 0.96 }));
    this.vaultEdgeMat = new THREE.LineBasicMaterial({ color: MAGENTA, toneMapped: false });
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry), this.vaultEdgeMat);
    this.vaultCore = new THREE.Mesh(new THREE.OctahedronGeometry(0.72), new THREE.MeshBasicMaterial({ color: MAGENTA, toneMapped: false, wireframe: true }));
    const ringGeo = new THREE.TorusGeometry(1.9, 0.045, 8, 32);
    const ringA = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: MAGENTA, toneMapped: false }));
    const ringB = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xff8af7, toneMapped: false }));
    ringB.rotation.x = Math.PI / 2;
    this.vaultRings = [ringA, ringB];
    const lockMat = new THREE.MeshBasicMaterial({ map: createPadlockTexture(), transparent: true, toneMapped: false });
    const lockGeos = [[0, 1.14, 0], [0, -1.14, Math.PI], [1.14, 0, Math.PI / 2], [-1.14, 0, -Math.PI / 2]].map(
      ([px, pz, ry]) => placed(new THREE.PlaneGeometry(1.35, 1.35), px, 0, pz, 0, ry, 0),
    );
    this.vault.add(cube, edges, this.vaultCore, ringA, ringB, new THREE.Mesh(mergeParts(lockGeos, true), lockMat));
    this.vault.position.copy(VAULT);
    this.vaultLight.position.copy(VAULT).add(new THREE.Vector3(0, 0.5, 2.2));
    const tag = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 0.7), label("PRIVATE ROLLUP", "#ff9af9", 768, 128));
    tag.position.set(VAULT.x, VAULT.y + 2.25, VAULT.z);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 16), new THREE.MeshBasicMaterial({ color: 0x6a1d7a, toneMapped: false }));
    stem.position.set(VAULT.x, VAULT.y - 9.5, VAULT.z);
    this.scene.add(this.vault, this.vaultLight, tag, stem);

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
    const cageMat = new THREE.MeshBasicMaterial({ color: RED, toneMapped: false });
    const cageGeos: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 12; k++) {
      cageGeos.push(placed(new THREE.CylinderGeometry(0.035, 0.035, 2.3), Math.cos((k / 12) * 6.283) * 1.15, 1.15, Math.sin((k / 12) * 6.283) * 1.15));
    }
    cageGeos.push(placed(new THREE.TorusGeometry(1.15, 0.035, 8, 24).rotateX(Math.PI / 2), 0, 2.3, 0));
    this.cage.add(new THREE.Mesh(mergeParts(cageGeos), cageMat));
    this.cage.visible = false;
    this.deck.add(this.coinMesh, this.wave, this.cage, this.nearGate);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.58, 0.45, 0.78);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
    new ResizeObserver(() => this.resize()).observe(host);
    this.renderer.domElement.addEventListener("click", this.click);
    this.renderer.domElement.addEventListener("pointermove", this.hover);
    (window as any).__tipoffScene = this;
    this.drawTicker();
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
      const { main, face } = optimizeBot(body, col);
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
    if (v.stage === "reveal" && i !== v.insider) return new THREE.Vector3(laneX(i) * 1.15, 0, 2.5);
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
    if (this.motionMq) this.reducedMotion = this.motionMq.matches;
    if (!this.reducedMotion) { this.shake = 0.6; this.flash = 1; }
    this.slow = 0.4; this.waveT = 0; this.tiltV += bps > 0 ? 1.6 : -1.6;
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
    if (v.stage !== "vote" || v.canVote === false) { this.hot = -1; this.renderer.domElement.style.cursor = ""; }
    if (!this.ready) { this.drawWall(v.wall, v.stage); return; }
    const changed = prev?.stage !== v.stage;
    if (changed) this.stageAt = this.clock.elapsedTime;
    this.tiltTo = v.stage === "live" ? THREE.MathUtils.clamp((v.wall.shocks.reduce((a, s) => a + (Math.abs(s.bps) > 1 ? s.bps : 0), 0) / 250) * 2.2, -7, 7) * (Math.PI / 180) : 0;
    this.nearGate.visible = !this.lined(v.stage);
    this.cage.visible = v.stage === "reveal" && v.caught && !!this.bots[v.insider];
    let longs = 0, shorts = 0;
    this.bots.forEach((b, i) => {
      const s = v.seats[i], col = this.col.set(this.colors[i]);
      if (!s.empty && v.stage === "live") { if (s.pos > 0) longs++; else if (s.pos < 0) shorts++; }
      if (v.stage !== "reveal") b.body.visible = !s.empty;
      const rm = b.ring.material as THREE.MeshBasicMaterial;
      rm.opacity = i === v.me ? 0.95 : 0;
      b.ring.visible = rm.opacity > 0.01;
      rm.color.set(i === v.me && v.insiderMe ? MAGENTA : col);
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
    this.longGateMat.emissiveIntensity = 1.15 + longs * 0.35;
    this.shortGateMat.emissiveIntensity = 1.15 + shorts * 0.35;
    this.longChevMat.opacity = Math.min(1, 0.32 + longs * 0.16);
    this.shortChevMat.opacity = Math.min(1, 0.32 + shorts * 0.16);
    this.drawWall(v.wall, v.stage);
  }

  private drawWall(w: Wall, stage: Stage = this.view?.stage ?? "idle") {
    const c = this.wallCanvas.getContext("2d")!, W = this.wallCanvas.width, H = this.wallCanvas.height;
    c.fillStyle = "#070b16";
    c.fillRect(0, 0, W, H);
    const usd = (p: number) => (p / 1e8).toFixed(2);
    const recent = w.marks.slice(-5).reverse();
    this.tickerText = stage === "idle" || stage === "deal"
      ? (stage === "deal" ? "DEALING SECRET ROLES  •  MAGICBLOCK VRF  •  PRIVATE ROLLUP" : "TIPOFF EXCHANGE  •  TAKE A SEAT TO START THE ROUND")
      : recent.length
        ? recent.map((m) => `${SEAT_NAMES[m.seat] ?? "TRADER"} ${m.delta > 0 ? `BUY +${m.delta}` : `SELL ${Math.abs(m.delta)}`} @ $${usd(m.p)}`).join("   •   ")
        : `ROUND ${w.round} LIVE  •  SOL $${usd(w.price || w.open)}`;

    if (stage === "idle" || stage === "deal") {
      c.strokeStyle = "rgba(43, 108, 255, 0.14)";
      c.lineWidth = 2;
      for (let x = 96; x < W; x += 128) { c.beginPath(); c.moveTo(x, 36); c.lineTo(x, H - 36); c.stroke(); }
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillStyle = stage === "deal" ? "#ff9af9" : "#f3f5ff";
      c.font = "900 72px Inter, system-ui, sans-serif";
      c.fillText(w.title || (stage === "deal" ? "DEALING SECRET ROLES" : "MARKET OPENS SOON"), W / 2, H / 2 - (w.sub ? 28 : 0));
      if (w.sub) {
        c.fillStyle = "#9aa5d0";
        c.font = "600 32px Inter, system-ui, sans-serif";
        c.fillText(w.sub, W / 2, H / 2 + 44);
      }
      c.textAlign = "left";
    } else {
      const up = w.price >= w.open;
      c.textBaseline = "top";
      const x0 = 54, x1 = W - 126, y0 = 50, y1 = H - 62, X = (t: number) => x0 + (t / 60) * (x1 - x0);
      const ps = [...w.points.map((p) => p.p), ...w.marks.map((m) => m.p), w.open || w.price].filter(Boolean);
      let lo = Math.min(...ps), hi = Math.max(...ps);
      const pad = Math.max((hi - lo) * 0.15, (w.open || 1) * 0.004);
      lo -= pad; hi += pad;
      const Y = (p: number) => y1 - ((p - lo) / (hi - lo)) * (y1 - y0);
      c.strokeStyle = "#182236";
      c.lineWidth = 2;
      for (let t = 0; t <= 60; t += 10) { c.beginPath(); c.moveTo(X(t), y0); c.lineTo(X(t), y1); c.stroke(); }
      c.fillStyle = "#8a98bd";
      c.font = "700 26px Inter, system-ui, sans-serif";
      for (let t = 0; t <= 60; t += 10) c.fillText(`${t}s`, X(t) - 14, y1 + 12);
      if (ps.length) {
        c.fillText(usd(hi), x1 + 14, y0 - 8);
        c.fillText(usd(lo), x1 + 14, y1 - 24);
        if (w.open) { c.setLineDash([8, 10]); c.strokeStyle = "#415278"; c.beginPath(); c.moveTo(x0, Y(w.open)); c.lineTo(x1, Y(w.open)); c.stroke(); c.setLineDash([]); }
      }
      const shocks = [...w.shocks].filter((s) => Math.abs(s.bps) > 1).sort((a, b) => a.at - b.at);
      let lastShockAt = -99, shockRow = 0;
      for (const s of shocks) {
        shockRow = s.at - lastShockAt < 8 ? (shockRow ^ 1) : 0;
        lastShockAt = s.at;
        c.strokeStyle = c.fillStyle = s.bps > 0 ? "#3ddc97" : "#ff6b6b";
        c.lineWidth = 3.5;
        c.setLineDash([10, 8]); c.beginPath(); c.moveTo(X(s.at), y0); c.lineTo(X(s.at), y1); c.stroke(); c.setLineDash([]);
        c.font = "800 28px Inter, system-ui, sans-serif";
        c.fillText(`NEWS ${s.bps > 0 ? "+" : "−"}${(Math.abs(s.bps) / 100).toFixed(1)}%`, X(s.at) + 8, y0 + 2 + shockRow * 36);
      }
      let lastTipAt = -99, tipRow = 0;
      for (const s of [...w.future].sort((a, b) => a.at - b.at)) {
        tipRow = s.at - lastTipAt < 8 ? (tipRow ^ 1) : 0;
        lastTipAt = s.at;
        c.strokeStyle = c.fillStyle = "#f5b83d";
        c.lineWidth = 3.5;
        c.setLineDash([4, 10]); c.beginPath(); c.moveTo(X(s.at), y0); c.lineTo(X(s.at), y1); c.stroke(); c.setLineDash([]);
        c.font = "800 28px Inter, system-ui, sans-serif";
        c.fillText(`TIP ${s.bps > 0 ? "+" : "−"}${(Math.abs(s.bps) / 100).toFixed(1)}%`, X(s.at) + 8, y1 - 36 - tipRow * 36);
      }
      if (w.points.length > 1) {
        c.lineJoin = "round";
        c.lineWidth = 7;
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
    }

    // Subtle LED scan-line overlay across the screen.
    c.fillStyle = "rgba(3, 6, 16, 0.22)";
    for (let y = 0; y < H; y += 6) c.fillRect(0, y, W, 2);
    this.wallTex.needsUpdate = true;
  }

  private drawTicker() {
    const g = this.tickerCanvas.getContext("2d")!, W = this.tickerCanvas.width, H = this.tickerCanvas.height;
    g.fillStyle = "#0a0f22";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#223468";
    g.fillRect(0, 0, W, 2);
    g.font = "700 26px Inter, system-ui, sans-serif";
    g.textBaseline = "middle";
    g.fillStyle = "#e6ebff";
    const gap = 80;
    const tw = Math.max(200, g.measureText(this.tickerText).width + gap);
    const x0 = -(this.tickerOffset % tw);
    for (let x = x0; x < W; x += tw) g.fillText(this.tickerText, x + 16, H / 2 + 1);
    this.tickerTex.needsUpdate = true;
  }

  private applyQuality(q: number) {
    this.quality = q;
    this.renderer.shadowMap.enabled = q >= 2;
    this.key.castShadow = q >= 2;
    for (const s of this.beamShadows) s.castShadow = q >= 2;
    this.audience.count = q >= 2 ? AUDIENCE_MAX : Math.floor(AUDIENCE_MAX / 2);
    for (const b of this.beams) {
      b.cone.visible = q > 0;
      if (b.spot) b.spot.intensity = q > 0 ? 32 : 0;
    }
    this.deckMat.normalMap = q > 0 ? this.brushedNormal : null;
    this.deckMat.needsUpdate = true;
    this.bloom.enabled = q > 0;
    this.renderer.setPixelRatio(q >= 2 ? Math.min(devicePixelRatio, 2) : q === 1 ? 1 : 0.75);
    this.composer.setPixelRatio(q >= 2 ? Math.min(devicePixelRatio, 2) : q === 1 ? 1 : 0.75);
    this.resize();
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
  private warmupFrames = 0;
  private badWindows = 0;
  /// Renderer facts for the proof panel and QA.
  stats() { const i = this.renderer.info; return { quality: this.quality, calls: i.render.calls, triangles: i.render.triangles, ratio: this.renderer.getPixelRatio() }; }
  private click = (e: MouseEvent) => { const s = this.pick(e); if (s >= 0 && this.view?.stage === "vote" && this.view.canVote !== false && s !== this.view.me && !this.view.seats[s].empty) this.onPick(s); };
  private hover = (e: PointerEvent) => {
    const s = this.view?.stage === "vote" && this.view.canVote !== false ? this.pick(e) : -1;
    this.hot = s >= 0 && s !== this.view!.me && !this.view!.seats[s].empty ? s : -1;
    this.renderer.domElement.style.cursor = this.hot >= 0 ? "pointer" : "";
  };

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /// Camera per stage. Adapts distance and framing so all lanes fit on narrow screens and reveals stay centred.
  private direct(v: View | null, t: number) {
    const aspect = this.camera.aspect || 1, a = Math.max(1, 1.5 / aspect), portrait = aspect < 1.25, stage = v?.stage ?? "idle";
    const meX = v && v.me >= 0 ? laneX(v.me) : 0, me = v && v.me >= 0 ? this.bots[v.me] : undefined;
    let fov = 50;
    if (this.orbit) {
      const sw = Math.sin(t * 0.14) * 0.95;
      this.camPos.set(Math.sin(sw) * 19 * a, portrait ? 8.2 : 7.4, Math.cos(sw) * 19 * a);
      this.camLook.set(0, 2.7, -3.5);
    }
    else if (stage === "live") {
      const last = v!.wall.elapsed >= 50, z = me ? Math.max(0, me.root.position.z) * 0.08 : 0;
      if (portrait) {
        fov = last ? 60 : 58;
        const minZ = 9.5 + 11.7 / Math.max(0.5, aspect);
        this.camPos.set(0, last ? 10.2 : 10.6, Math.max(19.4, minZ) + z * 0.6);
        this.camLook.set(0, 2.0, -0.5);
      } else {
        this.camPos.set(meX * 0.12, 6.9, 22.8 + z);
        this.camLook.set(meX * 0.08, 2.15, -0.5);
        fov = last ? 44 : 43;
      }
    } else if (stage === "deal" && me) { this.camPos.set(meX + 1.6, 2.1, -4.6 * a); this.camLook.set(meX, 1.5, 0); }
    else if (stage === "vote" || stage === "drum") {
      fov = portrait ? 56 : 54;
      const minDz = 6.3 / (Math.tan((fov * Math.PI) / 360) * aspect);
      this.camPos.set(this.hot >= 0 ? laneX(this.hot) * 0.12 : 0, portrait ? 2.9 : 2.55, 7.225 + Math.max(9.6, minDz));
      this.camLook.set(0, portrait ? 2.3 : 2.15, 6.6);
    } else if (stage === "reveal" && this.bots[v!.insider]) {
      const p = this.bots[v!.insider].root.position, k = Math.min(1, (t - this.stageAt) / 1.5);
      const back = portrait ? Math.max(10.2, 6.8 / Math.max(0.55, aspect)) - 0.6 * k : 10.2 - 0.9 * k;
      this.camPos.set(p.x * 0.72, portrait ? 3.0 : 2.85, p.z + back);
      this.camLook.set(p.x * 0.52, portrait ? 2.1 : 2.05, p.z);
      fov = portrait ? 60 : 56;
    } else { this.camPos.set(Math.sin(t * 0.2) * 2.5, 6.2, 15 * a); this.camLook.set(0, 3.6, -4); }
    this.fov += ((this.flash > 0.75 && !this.reducedMotion ? fov - 6 : fov) - this.fov) * 0.12;
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.motionMq) this.reducedMotion = this.motionMq.matches;
    const cw = this.host.clientWidth, ch = this.host.clientHeight;
    if (cw > 0 && ch > 0 && Math.abs(this.camera.aspect - cw / ch) > 0.01) this.resize();
    const real = Math.min(this.clock.getDelta(), 0.5), raw = Math.min(real, 0.1), t = this.clock.elapsedTime, v = this.view;
    this.slow = Math.max(0, this.slow - raw);
    const dt = raw * (this.slow > 0 ? 0.3 : 1);
    const stage = v?.stage ?? "idle", dark = this.lined(stage), last = stage === "live" && v!.wall.elapsed >= 50;

    this.direct(v, t);
    const k = 1 - Math.exp(-raw * (stage === "idle" ? 1.2 : 3));
    this.camera.position.lerp(this.camPos, k);
    this.look.lerp(this.camLook, k);
    if (!this.reducedMotion && this.shake > 0) {
      this.shake = Math.max(0, this.shake - raw);
      this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.6;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.6;
    } else this.shake = 0;
    this.camera.lookAt(this.look);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) { this.camera.fov = this.fov; this.camera.updateProjectionMatrix(); }

    // The deck is a spring: news kicks it, then it settles at the tilt the shocks have earned.
    this.tiltV += ((this.tiltTo - this.tilt) * 120 - this.tiltV * 9) * raw;
    this.tilt += this.tiltV * raw;
    this.deck.rotation.x = this.tilt;

    this.flash = this.reducedMotion ? 0 : Math.max(0, this.flash - raw * 0.9);
    this.amb.intensity += ((stage === "vote" ? 0.5 : dark ? 0.18 : 0.65) - this.amb.intensity) * k;
    this.key.intensity += ((dark ? 0.15 : last ? 0.75 : 1.35) - this.key.intensity) * k;
    const beat = last && !this.reducedMotion ? Math.max(0, 1 - ((v!.wall.elapsed % 1) * 3)) : 0;
    this.alarm.color.set(0xff3030);
    if (this.flash > 0) this.alarm.color.copy(this.flashColor);
    this.alarm.intensity = this.reducedMotion ? 0 : this.flash * 420 + beat * 160 + (stage === "drum" ? (Math.sin(t * 14) > 0 ? 120 : 0) : 0);
    this.wallMat.color.setScalar(dark ? 0.45 : 1).lerp(this.flashColor, this.flash * 0.5);
    this.bloom.strength = 0.58 + this.flash * 0.45 + (stage === "reveal" ? 0.2 : 0);

    // Vault rotation & glow (brighter during deal and reveal).
    const vaultHot = stage === "deal" || stage === "reveal";
    this.vault.rotation.y += raw * (stage === "deal" ? 4.2 : 0.35);
    this.vaultCore.rotation.x += raw * (vaultHot ? 2.6 : 1.3);
    this.vaultRings[0].rotation.z += raw * (vaultHot ? 2.4 : 0.9);
    this.vaultRings[1].rotation.y -= raw * (vaultHot ? 2.8 : 1.1);
    this.vaultLight.intensity += ((vaultHot ? 28 : 10) - this.vaultLight.intensity) * Math.min(1, raw * 6);
    this.vaultEdgeMat.color.set(MAGENTA).multiplyScalar(vaultHot ? 1.7 : 1.0);

    // Parallax candle columns & animated gate chevrons.
    if (!this.reducedMotion) {
      this.pitInner.rotation.y += raw * 0.015;
      this.pitOuter.rotation.y -= raw * 0.008;
      this.longChevTex.offset.y -= raw * 0.9;
      this.shortChevTex.offset.y -= raw * 0.9;
    }

    // Audience terminal flicker (off at quality 0 or reduced motion).
    if (this.quality > 0 && !this.reducedMotion) {
      this.audienceTimer += raw;
      if (this.audienceTimer > 0.08) {
        this.audienceTimer = 0;
        const cnt = this.audience.count;
        for (let k2 = 0; k2 < 10; k2++) {
          const idx = Math.floor(Math.random() * cnt);
          this.col.copy(this.audienceColors[idx]).multiplyScalar(0.5 + Math.random() * 0.95);
          this.audience.setColorAt(idx, this.col);
        }
        this.audience.instanceColor!.needsUpdate = true;
      }
    }

    // Ticker bar smooth scroll (throttled to ~15fps to protect CPU budget).
    if (!this.reducedMotion) this.tickerOffset += raw * 90;
    this.tickerDrawAt += raw;
    if (this.tickerDrawAt > 0.065) {
      this.tickerDrawAt = 0;
      this.drawTicker();
    }

    // Moving-head beams: sweep in idle, lock onto gates in live, red in last 10s, focus reveal/vote.
    if (this.quality > 0) {
      this.beams.forEach((mb, idx) => {
        const tgt = this.tmp.position;
        if (stage === "live") {
          const gateZ = idx < 2 ? -9.5 : 9.5;
          tgt.set(idx % 2 === 0 ? -4.2 : 4.2, 0.4, gateZ);
          mb.mat.color.set(last ? 0xff3b52 : idx < 2 ? GREEN : RED);
          mb.mat.opacity = last ? 0.2 : 0.14;
        } else if (stage === "reveal" && v && this.bots[v.insider]) {
          tgt.copy(this.bots[v.insider].root.position).setY(1.2);
          mb.mat.color.set(v.caught ? MAGENTA : RED);
          mb.mat.opacity = 0.18;
        } else if (stage === "vote" || stage === "drum") {
          tgt.set((idx - 1.5) * 3.0, 0.9, 6.6);
          mb.mat.color.set(0x88b4ff);
          mb.mat.opacity = 0.11;
        } else {
          const ph = t * 0.55 + idx * 1.57;
          tgt.set(Math.sin(ph) * 5.2, 0.2, Math.cos(ph * 0.8) * 6.5);
          mb.mat.color.set(idx % 2 === 0 ? GOLD : 0x7fd6ff);
          mb.mat.opacity = 0.13;
        }
        mb.pivot.lookAt(tgt);
        mb.pivot.rotateX(Math.PI / 2);
        if (mb.spot) {
          mb.spot.target.position.copy(tgt);
          mb.spot.color.copy(mb.mat.color);
          mb.spot.intensity = stage === "live" && last ? 46 : 32;
        }
      });
    }

    // Tiles: a green ramp toward LONG, red toward SHORT; the tile a robot stands on takes its colour.
    const tip = v?.insiderMe && stage === "live" ? v.wall.future.find((s) => s.at - v.wall.elapsed > 0 && s.at - v.wall.elapsed < 6) : undefined;
    for (let i = 0; i < N; i++) for (let p = -5; p <= 5; p++) {
      const s = v?.seats[i], on = s && !s.empty && s.pos === p && !dark;
      if (on) this.col.set(this.colors[i]).multiplyScalar(0.95);
      else if (p === 0) this.col.setScalar(dark ? 0.03 : 0.12);
      else this.col.set(p > 0 ? GREEN : RED).multiplyScalar(dark ? 0.018 : 0.08 + Math.abs(p) * 0.03 + this.flash * 0.22 + beat * 0.04);
      if (tip && i === v!.me && Math.sign(p) === Math.sign(tip.bps) && !on) this.col.lerp(new THREE.Color(MAGENTA), 0.25 + 0.25 * Math.sin(t * 9));
      this.tiles.setColorAt(i * 11 + p + 5, this.col);
    }
    this.tiles.instanceColor!.needsUpdate = true;

    let chosen = -1;
    const tagRects: { x: number; y: number; hw: number; h: number }[] = [];
    this.bots.forEach((b, i) => {
      b.mixer.update(dt);
      const s = v?.seats[i];
      b.down = Math.max(0, b.down - dt);
      if (b.down === 0 && b.current === "Death" && stage === "live") { this.play(b, "Idle"); this.express(b, "Sad"); }
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
      b.pulse.visible = pm.opacity > 0.01;
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
        const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
        const narrow = w < 700;
        const yOff = narrow && (stage === "live" || stage === "vote") && i % 2 === 1 ? 2.55 : 2.25;
        const p = world.setY(world.y + yOff).project(this.camera);
        const vis = p.z < 1 && stage !== "reveal";
        el.style.opacity = vis ? "1" : "0";
        if (vis) {
          const hw = Math.max(18, (el.offsetWidth || 48) / 2);
          const th = el.offsetHeight || 26;
          let px = THREE.MathUtils.clamp(((p.x + 1) / 2) * w, hw + 4, w - hw - 4);
          let py = ((1 - p.y) / 2) * h;
          if (narrow && i % 2 === 1) py -= th + 2;
          for (const r of [...tagRects].sort((a, b) => b.y - a.y)) {
            if (Math.abs(px - r.x) < hw + r.hw + 4 && py > r.y - r.h - 4 && py - th < r.y + 4) {
              py = r.y - r.h - 4;
            }
          }
          py = THREE.MathUtils.clamp(py, th + 4, h - 4);
          tagRects.push({ x: px, y: py, hw, h: th });
          el.style.transform = `translate(-50%,-100%) translate(${px.toFixed(1)}px,${py.toFixed(1)}px)`;
        }
      }
    });

    this.spotL.intensity += ((chosen >= 0 ? 110 : 0) - this.spotL.intensity) * Math.min(1, raw * 8);
    for (const f of this.prints) {
      if (f.life <= 0) continue;
      f.life -= dt / 10;
      (f.m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, f.life) * 0.8;
      if (f.life <= 0 || stage !== "live") { f.life = 0; f.m.visible = false; }
    }
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

    this.waveT += raw;
    const wm = this.wave.material as THREE.MeshBasicMaterial;
    wm.opacity = this.waveT < 0.55 ? 0.9 * (1 - this.waveT / 0.55) : 0;
    this.wave.visible = wm.opacity > 0.01;
    this.wave.position.set(0, 0.25, -9 + (this.waveT / 0.55) * 18);
    if (this.cage.visible) { this.cage.position.y = Math.max(0, this.cage.position.y - raw * 14); this.cage.rotation.y += raw * 0.6; }

    this.renderer.info.reset();
    this.composer.render();
    // Adaptive quality ladder: drop shadows/halve audience at Q1, disable beams/flicker/normal map/bloom at Q0.
    if (this.warmupFrames < 120) {
      this.warmupFrames++;
    } else if (!document.hidden) {
      this.frames++;
      this.spent += raw;
      if (this.frames === 45) {
        if (this.spent / 45 > 0.03 && this.quality > 0) {
          this.badWindows++;
          if (this.badWindows >= 2) {
            this.applyQuality(this.quality - 1);
            this.badWindows = 0;
          }
        } else {
          this.badWindows = 0;
        }
        this.frames = 0;
        this.spent = 0;
      }
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
    this.motionMq?.removeEventListener?.("change", this.onMotion);
    if ((window as any).__tipoffScene === this) delete (window as any).__tipoffScene;
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
