import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { sfx } from "./sound";

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
export type View = { stage: Stage; seats: SeatView[]; me: number; insiderMe: boolean; insider: number; caught: boolean; canVote?: boolean; accused?: number; allIn?: boolean; scores?: number[]; votes?: number[]; wall: Wall };

const N = 6, TILE = 1.6, GREEN = 0x3ddc97, RED = 0xff5c6c, MAGENTA = 0xff3df0, GOLD = 0xf5b83d;
const SEAT_NAMES = ["RUBY", "AMBER", "RUSTY", "JADE", "AZURE", "VIOLET"];
const laneX = (i: number) => (i - 2.5) * 2;
const VAULT = new THREE.Vector3(-8.5, 4.6, -9.5);
const AUDIENCE_MAX = 144;
const PARTICLE_CAP = 600;
const COIN_CAP = 380;

type Bot = {
  root: THREE.Group; body: THREE.Object3D; mixer: THREE.AnimationMixer; actions: Record<string, THREE.AnimationAction>; current: string;
  main: THREE.MeshStandardMaterial; face?: THREE.Mesh; neck?: THREE.Object3D; mask?: THREE.Mesh; chestMat?: THREE.MeshStandardMaterial;
  ring: THREE.Mesh; pulse: THREE.Mesh; spot: THREE.SpotLight; beam: THREE.Mesh;
  hold: boolean; holdEnd: boolean; moving: boolean; moveDist: number; lean: number; down: number; slump: number;
  yaw: number; trail: number; queue: string[]; dealDone: boolean; nervous: boolean; revealPending: boolean; nextGlance: number;
  showRole?: "none" | "accuser" | "wrong" | "idle";
  showPos?: THREE.Vector3;
  showPush?: THREE.Vector3;
  showPushStart?: THREE.Vector3;
  showYaw?: number;
  showSpeed?: number;
  showArrived?: boolean;
};
type Coin = { p: THREE.Vector3; v: THREE.Vector3; life: number; src?: THREE.Vector3; dst?: THREE.Vector3; t?: number; dur?: number; delay?: number; arcH?: number; spark?: number };
type Particle = { p: THREE.Vector3; v: THREE.Vector3; col: THREE.Color; life: number; maxLife: number; size: number; grav: number; drag: number; grow: number };
type Ripple = { seat: number; p: number; t: number; dur: number; col: THREE.Color };
type MovingBeam = { pivot: THREE.Group; cone: THREE.Mesh; mat: THREE.MeshBasicMaterial; spot?: THREE.SpotLight; base: THREE.Vector3 };

function createSweepTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 32;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 128, 0);
  grad.addColorStop(0, "rgba(255, 197, 49, 0)");
  grad.addColorStop(0.5, "rgba(255, 197, 49, 0.72)");
  grad.addColorStop(1, "rgba(255, 197, 49, 0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

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

function createChestBadgeTextures(num: number, hex: string) {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 128, 128);
  g.fillStyle = "#080d1e";
  g.strokeStyle = hex;
  g.lineWidth = 8;
  g.beginPath(); g.roundRect(10, 8, 108, 112, 16); g.fill(); g.stroke();
  g.fillStyle = hex;
  g.beginPath(); g.roundRect(24, 20, 80, 18, 9); g.fill();
  g.fillStyle = "#ffffff";
  g.beginPath(); g.roundRect(42, 24, 44, 10, 5); g.fill();
  g.font = "900 66px Inter, system-ui, sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = "#ffffff";
  g.fillText(String(num), 64, 78);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;

  const ec = document.createElement("canvas");
  ec.width = 128; ec.height = 128;
  const eg = ec.getContext("2d")!;
  eg.fillStyle = "#000000";
  eg.fillRect(0, 0, 128, 128);
  eg.strokeStyle = "#808080";
  eg.lineWidth = 6;
  eg.beginPath(); eg.roundRect(10, 8, 108, 112, 16); eg.stroke();
  eg.fillStyle = "#ffffff";
  eg.beginPath(); eg.roundRect(22, 18, 84, 22, 10); eg.fill();
  const emissiveMap = new THREE.CanvasTexture(ec);
  emissiveMap.colorSpace = THREE.SRGBColorSpace;
  return { map, emissiveMap };
}

function createInsiderMaskTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 256, 128);
  g.fillStyle = "#090410";
  g.strokeStyle = "#ff3df0";
  g.lineWidth = 6;
  g.beginPath();
  g.moveTo(14, 42);
  g.quadraticCurveTo(64, 16, 128, 44);
  g.quadraticCurveTo(192, 16, 242, 42);
  g.lineTo(234, 88);
  g.quadraticCurveTo(186, 104, 128, 78);
  g.quadraticCurveTo(70, 104, 22, 88);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = "#ff4df2";
  for (const ex of [72, 184]) {
    g.beginPath();
    g.ellipse(ex, 62, 26, 15, ex < 128 ? 0.14 : -0.14, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
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
        float fresnel = pow(1.0 - ndv, 2.3);
        float sideMask = 1.0 - smoothstep(0.65, 0.96, abs(vNormalV.y));
        vec3 base = vInstCol * 0.88 + vec3(0.012, 0.018, 0.045);
        vec3 edgeGlow = (vInstCol * 1.35 + vec3(0.02, 0.03, 0.06)) * (fresnel * 0.82 + sideMask * 0.65);
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

function optimizeBot(body: THREE.Object3D, col: THREE.Color, seatIdx: number, hexStr: string, maskTex: THREE.CanvasTexture) {
  body.updateMatrixWorld(true);
  let baseSkin: THREE.SkinnedMesh | undefined;
  let neck: THREE.Object3D | undefined;
  let chestBoneIdx = 0;
  body.traverse((o) => {
    if (!baseSkin && (o as THREE.SkinnedMesh).isSkinnedMesh) baseSkin = o as THREE.SkinnedMesh;
    if (!neck && (o as THREE.Bone).isBone && o.name === "Neck") neck = o;
  });
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
      if (mesh.name.startsWith("Torso")) chestBoneIdx = boneIdx;
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

  const { map, emissiveMap } = createChestBadgeTextures(seatIdx + 1, hexStr);
  const chestMat = new THREE.MeshStandardMaterial({
    map, emissiveMap, emissive: col.clone(), emissiveIntensity: 1.6,
    roughness: 0.35, metalness: 0.45, transparent: true,
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
    const badgeGeo = new THREE.PlaneGeometry(0.42, 0.44);
    badgeGeo.translate(0, 0.92, 0.312);
    badgeGeo.applyMatrix4(invBind);
    const cnt = badgeGeo.attributes.position.count;
    const idxArr = new Uint16Array(cnt * 4);
    const wArr = new Float32Array(cnt * 4);
    for (let v = 0; v < cnt; v++) { idxArr[v * 4] = chestBoneIdx; wArr[v * 4] = 1; }
    badgeGeo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(idxArr, 4));
    badgeGeo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(wArr, 4));
    const badgeSm = new THREE.SkinnedMesh(badgeGeo, chestMat);
    badgeSm.frustumCulled = false;
    badgeSm.castShadow = false;
    parent.add(badgeSm);
    badgeSm.bind(skel, bindMat);
  }

  let mask: THREE.Mesh | undefined;
  if (face?.parent) {
    const maskGeo = new THREE.CylinderGeometry(0.0148, 0.0148, 0.0094, 12, 1, true, -0.78, 1.56);
    maskGeo.rotateX(Math.PI / 2);
    maskGeo.translate(0, 0, 0.0026);
    mask = new THREE.Mesh(maskGeo, new THREE.MeshBasicMaterial({ map: maskTex, transparent: true, side: THREE.DoubleSide, toneMapped: false }));
    mask.visible = false;
    face.parent.add(mask);
  }

  return { main, face, neck, mask, chestMat };
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
  private printMesh!: THREE.InstancedMesh;
  private prints: { x: number; z: number; seat: number; life: number }[] = [];
  private printAt = 0;
  private maskTex = createInsiderMaskTexture();
  private coins: Coin[] = [];
  private coinMesh: THREE.InstancedMesh;
  private particles: Particle[] = [];
  private ptMesh: THREE.InstancedMesh;
  private ptActive = false;
  private ripples: Ripple[] = [];
  private wave: THREE.Mesh;
  private waveT = 9;
  private ringWave: THREE.Mesh;
  private ringWaveT = 9;
  private ringWaveStrong = false;
  private rumourSweepMesh!: THREE.Mesh;
  private rumourSweep = 0;
  private laserA!: THREE.Mesh;
  private laserB!: THREE.Mesh;
  private laserSeat = -1;
  private accusedAllIn = false;
  private laserFlare = 0;
  private cageVy = 0;
  private cageSlammed = false;
  private cagePending = false;
  private payoutDone = false;
  private showPhase: "idle" | "charge" | "knock" | "done" = "idle";
  private showKnockAt = 0;
  private showDanceDone = false;
  private showStandDone = false;
  private showInit = false;
  private showLock = false;
  private showAccusers: number[] = [];
  private showCenterX = 0;
  private showHalfX = 2.0;
  private showMaxZOff = 1.6;
  private fxEdge!: HTMLDivElement;
  private fxFlash!: HTMLDivElement;
  private fxVig!: HTMLDivElement;
  private cage = new THREE.Group();
  private nearGate = new THREE.Group();
  private longGateMat!: THREE.MeshStandardMaterial;
  private shortGateMat!: THREE.MeshStandardMaterial;
  private longChevMat!: THREE.MeshBasicMaterial;
  private shortChevMat!: THREE.MeshBasicMaterial;
  private longChevTex!: THREE.CanvasTexture;
  private shortChevTex!: THREE.CanvasTexture;
  private vault = new THREE.Group();
  private vaultTag!: THREE.Mesh;
  private vaultCore!: THREE.Mesh;
  private vaultRings: THREE.Mesh[] = [];
  private vaultEdgeMat!: THREE.LineBasicMaterial;
  private vaultLight = new THREE.PointLight(MAGENTA, 10, 18);
  private audience!: THREE.InstancedMesh;
  private audienceColors: THREE.Color[] = [];
  private audienceTimer = 0;
  private overheadTruss!: THREE.Mesh;
  private overheadGoldTruss!: THREE.Mesh;
  private pitInner!: THREE.InstancedMesh;
  private pitOuter!: THREE.InstancedMesh;
  private beams: MovingBeam[] = [];
  private beamShadows: THREE.SpotLight[] = [];
  private wallCanvas = document.createElement("canvas");
  private wallTex: THREE.CanvasTexture;
  private wallMat: THREE.MeshBasicMaterial;
  private tickerCanvas = document.createElement("canvas");
  private tickerTex: THREE.CanvasTexture;
  private tickerMat!: THREE.MeshBasicMaterial;
  private vaultTagMat!: THREE.MeshBasicMaterial;
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
  private liveFrameKey = "";
  private liveLookY = 3.5;
  private look = new THREE.Vector3(0, 1, 0);
  private camFromPos = new THREE.Vector3(0, 8, 22);
  private camFromLook = new THREE.Vector3(0, 1, 0);
  private camFromFov = 50;
  private transT = 1;
  private transDur = 1;
  private fov = 50;
  private shake = 0;
  private flash = 0;
  private shockPush = 0;
  private flashColor = new THREE.Color();
  private slow = 0;
  private tilt = 0;
  private tiltV = 0;
  private tiltTo = 0;
  private stageAt = 0;
  private lastTrader = -1;
  private glanceAt = -10;
  private accused = -1;
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
    this.edgeFillL.position.set(-7.6, 2.6, 0);
    this.edgeFillR.position.set(7.6, 2.6, 0);
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
      color: 0x3b82ff, emissive: 0x1e40af, emissiveIntensity: 0.85, roughness: 0.36, metalness: 0.15,
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
    this.shortChevTex = createChevronTexture("#ff3048");
    this.longChevMat = new THREE.MeshBasicMaterial({ map: this.longChevTex, transparent: true, opacity: 0.34, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.shortChevMat = new THREE.MeshBasicMaterial({ map: this.shortChevTex, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });

    const darkMetalGeos: THREE.BufferGeometry[] = [];
    const trussGeos: THREE.BufferGeometry[] = [];
    const goldTrussGeos: THREE.BufferGeometry[] = [];
    const buildGate = (z: number, hex: number, text: string, near: boolean) => {
      const m = new THREE.MeshStandardMaterial({ color: 0x070a14, emissive: hex, emissiveIntensity: 1.5, roughness: 0.4, metalness: 0.6 });
      if (near) this.shortGateMat = m; else this.longGateMat = m;
      const g = near ? this.nearGate : this.deck;
      const ph = near ? 0.72 : 3.2;
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
        for (const s of [-1, 1]) gateGeos.push(placed(new THREE.BoxGeometry(0.56, 0.16, 0.42), s * 6.15, ph, z));
        gateGeos.push(placed(new THREE.BoxGeometry(12.6, 0.09, 0.28), 0, 0.045, z));
      }
      g.add(new THREE.Mesh(mergeParts(gateGeos), m));
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.0, 0.9), label(text, "#" + new THREE.Color(hex).getHexString()));
      if (near) {
        sign.rotation.x = -Math.PI / 2.8;
        sign.position.set(0, 0.24, 9.48);
        sign.scale.setScalar(0.85);
      } else {
        sign.position.set(0, 3.65, z);
      }
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
    trussGeos.push(
      placed(new THREE.TorusGeometry(15.2, 0.16, 6, 32).rotateX(Math.PI / 2), 0, trussY, 0),
      placed(new THREE.TorusGeometry(14.1, 0.13, 6, 32).rotateX(Math.PI / 2), 0, trussY - 0.55, 0),
      placed(new THREE.BoxGeometry(18.5, 0.22, 0.28), 0, trussY - 0.55, -10.8),
    );
    goldTrussGeos.push(
      placed(new THREE.TorusGeometry(14.65, 0.045, 6, 32).rotateX(Math.PI / 2), 0, trussY - 0.3, 0),
      placed(new THREE.BoxGeometry(18.5, 0.05, 0.32), 0, trussY - 0.68, -10.8),
    );

    const strutCount = 24;
    const strutGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.25, 6);
    for (let i = 0; i < strutCount; i++) {
      const a = (i / strutCount) * Math.PI * 2;
      trussGeos.push(placed(strutGeo, Math.sin(a) * 14.65, trussY - 0.28, Math.cos(a) * 14.65, 0, -a, 0.55));
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
        const a = -Math.PI * 0.65 + frac * Math.PI * 1.3;
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
    this.overheadTruss = new THREE.Mesh(mergeParts(trussGeos), frameMat);
    this.overheadGoldTruss = new THREE.Mesh(mergeParts(goldTrussGeos), goldTrimMat);
    this.scene.add(
      new THREE.Mesh(mergeParts(darkMetalGeos), frameMat),
      new THREE.Mesh(mergeParts(goldArenaGeos), goldTrimMat),
      this.overheadTruss,
      this.overheadGoldTruss,
    );
    this.tickerCanvas.width = 1024;
    this.tickerCanvas.height = 56;
    this.tickerTex = new THREE.CanvasTexture(this.tickerCanvas);
    this.tickerTex.colorSpace = THREE.SRGBColorSpace;
    this.tickerMat = new THREE.MeshBasicMaterial({ map: this.tickerTex, toneMapped: false });
    const tickerMesh = new THREE.Mesh(new THREE.PlaneGeometry(13.6, 0.66), this.tickerMat);
    tickerMesh.position.set(0, 4.72, -12.56);
    this.rumourSweepMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(4.4, 5.2),
      new THREE.MeshBasicMaterial({ map: createSweepTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, opacity: 0.72 }),
    );
    this.rumourSweepMesh.position.set(0, 7.65, -12.52);
    this.rumourSweepMesh.visible = false;
    this.scene.add(wall, tickerMesh, this.rumourSweepMesh);

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
    this.vaultTagMat = label("PRIVATE ROLLUP", "#ff9af9", 768, 128);
    this.vaultTag = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 0.7), this.vaultTagMat);
    this.vaultTag.position.set(VAULT.x, VAULT.y + 2.25, VAULT.z);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 16), new THREE.MeshBasicMaterial({ color: 0x6a1d7a, toneMapped: false }));
    stem.position.set(VAULT.x, VAULT.y - 9.5, VAULT.z);
    this.scene.add(this.vault, this.vaultLight, this.vaultTag, stem);

    // Effects: pooled coins, single 600-particle pool, shockwave ring, vote lasers, and host CSS overlays.
    const coin = new THREE.CylinderGeometry(0.13, 0.13, 0.04, 10);
    this.coinMesh = new THREE.InstancedMesh(coin, new THREE.MeshStandardMaterial({ color: GOLD, emissive: GOLD, emissiveIntensity: 0.7, metalness: 1, roughness: 0.25 }), COIN_CAP);
    this.coinMesh.frustumCulled = false;
    this.coinMesh.visible = false;
    this.tmp.scale.setScalar(0); this.tmp.updateMatrix();
    for (let i = 0; i < COIN_CAP; i++) { this.coinMesh.setMatrixAt(i, this.tmp.matrix); this.coins.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0 }); }
    this.ptMesh = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(0.11, 0),
      new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }),
      PARTICLE_CAP,
    );
    this.ptMesh.frustumCulled = false;
    this.ptMesh.visible = false;
    for (let i = 0; i < PARTICLE_CAP; i++) {
      this.ptMesh.setMatrixAt(i, this.tmp.matrix);
      this.ptMesh.setColorAt(i, this.col.set(0));
      this.particles.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), col: new THREE.Color(), life: 0, maxLife: 1, size: 1, grav: 0, drag: 1, grow: 0 });
    }
    this.wave = new THREE.Mesh(new THREE.BoxGeometry(12.4, 0.5, 0.35), new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0 }));
    this.ringWave = new THREE.Mesh(
      new THREE.RingGeometry(0.68, 1.0, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: GREEN, toneMapped: false, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.ringWave.position.y = 0.06;
    this.ringWave.visible = false;
    const laserGeo = new THREE.CylinderGeometry(1, 1, 1, 8).rotateX(Math.PI / 2);
    this.laserA = new THREE.Mesh(laserGeo, new THREE.MeshBasicMaterial({ color: 0xff2846, toneMapped: false, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.laserB = new THREE.Mesh(laserGeo, new THREE.MeshBasicMaterial({ color: 0xff6230, toneMapped: false, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.laserA.visible = this.laserB.visible = false;
    this.laserA.frustumCulled = this.laserB.frustumCulled = false;
    this.scene.add(this.laserA, this.laserB);
    this.fxEdge = document.createElement("div"); this.fxEdge.className = "fx-edge"; this.fxEdge.setAttribute("aria-hidden", "true");
    this.fxFlash = document.createElement("div"); this.fxFlash.className = "fx-flash"; this.fxFlash.setAttribute("aria-hidden", "true");
    this.fxVig = document.createElement("div"); this.fxVig.className = "fx-vig"; this.fxVig.setAttribute("aria-hidden", "true");
    host.append(this.fxEdge, this.fxFlash, this.fxVig);
    const foot = new THREE.PlaneGeometry(0.62, 0.42).rotateX(-Math.PI / 2);
    this.printMesh = new THREE.InstancedMesh(foot, new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.75, depthWrite: false }), 96);
    this.printMesh.frustumCulled = false;
    for (let i = 0; i < 96; i++) {
      this.printMesh.setMatrixAt(i, this.tmp.matrix);
      this.printMesh.setColorAt(i, this.col.set(0));
      this.prints.push({ x: 0, z: 0, seat: 0, life: 0 });
    }
    const cageMat = new THREE.MeshBasicMaterial({ color: RED, toneMapped: false });
    const cageGeos: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 12; k++) {
      cageGeos.push(placed(new THREE.CylinderGeometry(0.035, 0.035, 2.3), Math.cos((k / 12) * 6.283) * 1.15, 1.15, Math.sin((k / 12) * 6.283) * 1.15));
    }
    cageGeos.push(placed(new THREE.TorusGeometry(1.15, 0.035, 8, 24).rotateX(Math.PI / 2), 0, 2.3, 0));
    this.cage.add(new THREE.Mesh(mergeParts(cageGeos), cageMat));
    this.cage.visible = false;
    this.deck.add(this.coinMesh, this.ptMesh, this.printMesh, this.wave, this.ringWave, this.cage, this.nearGate);

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
    if (import.meta.env.DEV) {
      const sdMode = new URLSearchParams(window.location.search).get("showdown");
      if (sdMode === "caught" || sdMode === "escaped") {
        (window as any).__showdown = () => {
          if (!this.ready) return false;
          const caught = sdMode === "caught";
          this.orbit = false;
          this.showLock = false;
          const wall = this.view?.wall ?? {
            price: 150_00000000, open: 150_00000000, elapsed: 60, round: 999,
            points: [], marks: [], shocks: [], future: [], title: "", sub: "",
          };
          const drumView: View = {
            stage: "drum",
            seats: Array.from({ length: N }, (_, k) => ({ empty: false, pos: k % 2 ? 2 : -2, mood: 0 })),
            me: 0,
            insiderMe: false,
            insider: 2,
            caught,
            votes: [2, 2, 255, 2, 0, 255],
            wall,
          };
          this.bots.forEach((b, k) => {
            b.body.visible = true;
            b.root.position.copy(this.spot(k, drumView));
            b.yaw = Math.PI;
            b.root.rotation.y = Math.PI;
            b.moving = false;
            b.down = 0;
            b.slump = 0;
            b.queue = [];
            b.hold = false;
            b.holdEnd = false;
            this.play(b, "Idle");
          });
          this.view = drumView;
          this.showInit = false;
          this.transT = 1;
          this.set({ ...drumView, stage: "reveal" });
          this.showLock = true;
          this.transT = 1;
          this.direct(this.view, this.clock.elapsedTime);
          this.camera.position.copy(this.camPos);
          this.look.copy(this.camLook);
          this.fov = this.targetFov;
          this.camera.fov = this.fov;
          this.camera.updateProjectionMatrix();
          this.camera.lookAt(this.look);
          this.camera.updateMatrixWorld(true);
          return true;
        };
      }
    }
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
      const { main, face, neck, mask, chestMat } = optimizeBot(body, col, i, this.colors[i], this.maskTex);
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
      actions.Idle.time = Math.random() * 3.33;
      actions.Idle.play();
      const bot: Bot = {
        root, body, mixer, actions, current: "Idle", main, face, neck, mask, chestMat, ring, pulse, spot, beam,
        hold: false, holdEnd: false, moving: false, moveDist: 0, lean: 0, down: 0, slump: 0, yaw: Math.PI, trail: 0,
        queue: [], dealDone: false, nervous: false, revealPending: false, nextGlance: 2 + Math.random() * 4,
      };
      mixer.addEventListener("finished", () => {
        if (bot.queue.length > 0) {
          const nextClip = bot.queue.shift()!;
          const isFinalHold = bot.queue.length === 0 && bot.holdEnd;
          this.play(bot, nextClip, !isFinalHold, isFinalHold);
          if (nextClip === "Sitting" && this.view?.stage === "reveal") this.express(bot, "Sad");
        } else if (!bot.hold) {
          this.play(bot, "Idle", false, false, bot.nervous ? 1.3 : 1);
        }
      });
      this.bots.push(bot);
    }
    this.ready = true;
    this.applyQuality(this.quality);
    if (this.view) this.set(this.view);
  }

  private play(b: Bot, name: string, once = false, hold = false, speed = 1) {
    const next = b.actions[name], prev = b.actions[b.current];
    if (!next) return;
    if (b.current === name && !once) { next.timeScale = speed; return; }
    next.reset();
    next.timeScale = speed;
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    next.clampWhenFinished = hold;
    b.hold = hold;
    if (prev && prev !== next) next.crossFadeFrom(prev, 0.2, false);
    next.play();
    b.current = name;
  }

  private playSeq(b: Bot, seq: string[], holdEnd = false) {
    if (!seq.length) return;
    b.holdEnd = holdEnd;
    b.queue = seq.slice(1);
    const singleHold = b.queue.length === 0 && holdEnd;
    this.play(b, seq[0], true, singleHold);
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

  private maxParticles() { return this.quality >= 2 ? PARTICLE_CAP : this.quality === 1 ? 300 : 0; }

  private emit(count: number, init: (p: Particle, idx: number) => void) {
    const cap = this.maxParticles();
    if (cap <= 0) return;
    let n = this.quality === 1 ? Math.ceil(count * 0.5) : count;
    let spawned = 0;
    for (let i = 0; i < cap && n > 0; i++) {
      const p = this.particles[i];
      if (p.life > 0) continue;
      init(p, spawned++);
      n--;
      this.ptActive = true;
    }
  }

  private triggerShockCss(up: boolean, strong: boolean) {
    if (this.reducedMotion || this.quality === 0) return;
    this.fxFlash.className = `fx-flash ${up ? "up" : "down"}${strong ? " strong" : ""}`;
    this.fxVig.className = `fx-vig${strong ? " strong" : ""}`;
    void this.fxFlash.offsetWidth;
    this.fxFlash.classList.add("go");
    this.fxVig.classList.add("go");
  }

  private arcCoin(from: THREE.Vector3, to: THREE.Vector3, delay = 0, dur = 0.55, arcH = 2.2, spark?: number) {
    if (this.quality === 0) return;
    for (const c of this.coins) {
      if (c.life > 0) continue;
      c.src = (c.src ?? new THREE.Vector3()).copy(from);
      c.dst = (c.dst ?? new THREE.Vector3()).copy(to);
      c.p.copy(from);
      c.v.set(0, 0, 0);
      c.t = 0;
      c.dur = dur;
      c.delay = delay;
      c.arcH = arcH;
      c.spark = spark;
      c.life = delay + dur + 0.05;
      return;
    }
  }

  private launchPayouts(scores: number[]) {
    if (this.quality === 0) return;
    const losers: { i: number; amt: number }[] = [];
    const winners: { i: number; amt: number }[] = [];
    for (let i = 0; i < N; i++) {
      const sc = scores[i] ?? 0;
      if (sc < -0.5) losers.push({ i, amt: -sc });
      else if (sc > 0.5) winners.push({ i, amt: sc });
    }
    const totalWin = winners.reduce((a, w) => a + w.amt, 0);
    const totalLoss = losers.reduce((a, l) => a + l.amt, 0);
    if (!totalWin || !totalLoss) return;
    const totalChips = this.quality >= 2 ? 96 : 48;
    let idx = 0;
    for (const l of losers) {
      const lBot = this.bots[l.i];
      if (!lBot) continue;
      for (const w of winners) {
        const wBot = this.bots[w.i];
        if (!wBot) continue;
        const share = Math.max(1, Math.round(totalChips * (l.amt / totalLoss) * (w.amt / totalWin)));
        for (let k = 0; k < share; k++) {
          const from = lBot.root.position.clone().setY(0.35).add(new THREE.Vector3((Math.random() - 0.5) * 0.45, 0, (Math.random() - 0.5) * 0.45));
          const to = wBot.root.position.clone().setY(0.45).add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4));
          this.arcCoin(from, to, (idx++ % 16) * 0.025, 0.52 + Math.random() * 0.22, 1.8 + Math.random() * 1.1, k === 0 ? GOLD : undefined);
        }
      }
    }
  }

  /// A trade landed: ring the tile, ripple outward two tiles, and spray seat sparks toward the gate.
  trade(seat: number, delta: number) {
    const b = this.bots[seat];
    if (!b || this.view?.stage !== "live") return;
    this.lastTrader = seat;
    this.glanceAt = this.clock.elapsedTime;
    const m = b.pulse.material as THREE.MeshBasicMaterial;
    m.color.set(delta > 0 ? GREEN : RED);
    m.opacity = 1;
    b.pulse.scale.setScalar(1);
    if (this.quality === 0) return;
    const row = THREE.MathUtils.clamp(Math.round(-b.root.position.z / TILE), -5, 5);
    if (this.ripples.length >= 12) this.ripples.shift();
    this.ripples.push({ seat, p: row, t: 0, dur: 0.54, col: new THREE.Color(this.colors[seat]) });
    const gz = delta > 0 ? -1 : 1;
    const col = new THREE.Color(this.colors[seat]);
    this.emit(26, (pt) => {
      pt.p.set(b.root.position.x + (Math.random() - 0.5) * 0.55, 0.25 + Math.random() * 0.25, b.root.position.z);
      pt.v.set((Math.random() - 0.5) * 2.4, 2.2 + Math.random() * 3.0, gz * (6.0 + Math.random() * 5.5));
      pt.col.copy(col).multiplyScalar(1.45);
      pt.maxLife = pt.life = 0.48 + Math.random() * 0.24;
      pt.size = 1.65 + Math.random() * 0.75;
      pt.grav = 6; pt.drag = 0.96; pt.grow = -0.3;
    });
  }

  /// News or rumour hits: rumour sweeps the jumbotron silently; shock lurches, flashes, rings, and awards coins.
  news(bps: number, opts?: { rumour?: boolean; fourth?: boolean }) {
    const v = this.view;
    if (this.motionMq) this.reducedMotion = this.motionMq.matches;
    if (opts?.rumour) {
      if (this.quality > 0 && !this.reducedMotion) this.rumourSweep = 1;
      return;
    }
    const strong = !!opts?.fourth;
    const mult = strong ? 2 : 1;
    if (this.reducedMotion || this.quality === 0) {
      this.shake = 0;
      this.flash = 0;
      this.shockPush = 0;
    } else {
      this.shake = 0.55 * mult;
      this.flash = 1;
      this.shockPush = 0.9 * mult;
    }
    this.slow = 0.4;
    this.waveT = this.quality > 0 && !this.reducedMotion ? 0 : 9;
    this.ringWave.position.set(0, 0.06, 0);
    this.ringWaveT = this.quality > 0 ? 0 : 9;
    this.ringWaveStrong = strong;
    this.tiltV += (bps > 0 ? 1.55 : -1.55) * mult;
    this.flashColor.set(bps > 0 ? GREEN : RED);
    (this.wave.material as THREE.MeshBasicMaterial).color.copy(this.flashColor);
    (this.ringWave.material as THREE.MeshBasicMaterial).color.copy(this.flashColor);
    this.triggerShockCss(bps > 0, strong);
    if (this.quality > 0) {
      this.emit(strong ? 44 : 24, (pt, idx) => {
        const a = (idx / (strong ? 44 : 24)) * Math.PI * 2 + Math.random() * 0.3;
        const spd = (6 + Math.random() * 7) * (strong ? 1.35 : 1);
        pt.p.set(Math.cos(a) * 0.6, 0.2, Math.sin(a) * 0.6);
        pt.v.set(Math.cos(a) * spd, 2.0 + Math.random() * 3.0, Math.sin(a) * spd);
        pt.col.copy(this.flashColor);
        pt.maxLife = pt.life = 0.48 + Math.random() * 0.25;
        pt.size = strong ? 1.5 : 1.1;
        pt.grav = 5; pt.drag = 0.94; pt.grow = -0.4;
      });
    }
    if (!v) return;
    const gateZ = bps > 0 ? -9.5 : 9.5;
    this.bots.forEach((b, i) => {
      const s = v.seats[i];
      if (s.empty) return;
      const side = Math.sign(s.pos) * Math.sign(bps), lots = Math.abs(s.pos);
      if (side > 0) {
        if (lots >= 3) this.play(b, "Dance", true); else this.playSeq(b, ["Jump", "ThumbsUp"]);
        this.express(b, null);
        const coinN = Math.min(28, lots * (strong ? 8 : 4));
        const gateFrom = new THREE.Vector3(laneX(i), 1.4, gateZ);
        for (let k = 0; k < (this.quality === 1 ? Math.ceil(coinN * 0.5) : coinN); k++) {
          const from = gateFrom.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.1, Math.random() * 0.5, 0));
          const to = b.root.position.clone().setY(0.35).add(new THREE.Vector3((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5));
          this.arcCoin(from, to, (k % 8) * 0.03, 0.42 + Math.random() * 0.22, 2.1 + Math.random() * 1.3, k < 2 ? GOLD : undefined);
        }
      } else if (side < 0 && lots >= 4) {
        b.slump = 2.6;
        this.play(b, "Death", true, true); this.express(b, "Surprised"); b.down = 1.6;
      } else if (side < 0) {
        b.slump = 3.2;
        this.play(b, "No", true); this.express(b, "Sad");
      } else this.play(b, "Jump", true);
    });
  }

  private fountain(at: THREE.Vector3, n: number, behind = false) {
    if (this.quality === 0) return;
    const cap = this.quality === 1 ? Math.ceil(n * 0.5) : n;
    let left = cap;
    for (const c of this.coins) {
      if (left <= 0) break;
      if (c.life > 0) continue;
      c.src = undefined; c.dst = undefined; c.delay = 0; c.spark = undefined;
      c.p.set(at.x, 1.7, at.z - (behind ? 1.4 : 0));
      c.v.set((Math.random() - 0.5) * (behind ? 2.6 : 3.2), 5.2 + Math.random() * 4.5, behind ? -0.6 - Math.random() * 1.3 : (Math.random() - 0.5) * 3.2);
      c.life = 1.6 + Math.random() * 0.5;
      left--;
    }
  }

  private showdownAngles(insPos: THREE.Vector3, insIdx: number, accusers: number[]): number[] {
    const k = accusers.length;
    if (k === 0) return [];
    if (insPos.x < -3.0) {
      if (k === 1) return [1.15];
      return accusers.map((_, idx) => 1.06 + (idx / (k - 1)) * 1.45);
    }
    if (insPos.x > 3.0) {
      if (k === 1) return [-1.15];
      return accusers.map((_, idx) => -2.51 + (idx / (k - 1)) * 1.45);
    }
    const left = accusers.filter((a) => a < insIdx).length;
    if (k === 1) return [accusers[0] < insIdx ? -1.12 : 1.12];
    if (k === 2) return [-1.18, 1.18];
    if (k === 3) return left >= 2 ? [-2.28, -1.28, 1.18] : [-1.18, 1.28, 2.28];
    if (k === 4) return [-1.95, -1.10, 1.10, 1.95];
    return left >= 3 ? [-2.18, -1.58, -1.06, 1.12, 1.95] : [-1.95, -1.12, 1.06, 1.58, 2.18];
  }

  private emitMagentaBurst(at: THREE.Vector3, count: number, ringVel: boolean) {
    if (this.quality <= 0) return;
    this.emit(count, (pt, idx) => {
      const a = (idx / count) * Math.PI * 2 + Math.random() * 0.35;
      if (ringVel) {
        const spd = 6.5 + Math.random() * 5.5;
        pt.p.set(at.x + Math.cos(a) * 0.4, 0.45, at.z + Math.sin(a) * 0.4);
        pt.v.set(Math.cos(a) * spd, 1.2 + Math.random() * 2.4, Math.sin(a) * spd);
        pt.col.set(idx % 2 === 0 ? MAGENTA : 0xff8af7);
        pt.maxLife = pt.life = 0.48 + Math.random() * 0.25;
        pt.size = 1.45; pt.grav = 3.5; pt.drag = 0.93; pt.grow = -0.35;
      } else {
        const r = 0.65 + Math.random() * 0.75;
        pt.p.set(at.x + Math.cos(a) * r, 0.35 + Math.random() * 1.15, at.z - 0.15 + Math.sin(a) * r);
        pt.v.set(Math.cos(a) * (1.8 + Math.random() * 2.0), 1.3 + Math.random() * 1.9, Math.sin(a) * (1.8 + Math.random() * 2.0));
        pt.col.set(idx % 2 === 0 ? 0xa61fd6 : 0xe032b8).multiplyScalar(0.32);
        pt.maxLife = pt.life = 0.9 + Math.random() * 0.45;
        pt.size = 1.45 + Math.random() * 0.75;
        pt.grav = -0.5; pt.drag = 0.94; pt.grow = 1.15;
      }
    });
  }

  private setupShowdown(v: View) {
    const ins = v.insider, insBot = this.bots[ins];
    if (!insBot) return;
    this.showInit = true;
    this.showDanceDone = false;
    this.showStandDone = false;
    this.showKnockAt = 0;
    const insPos = insBot.root.position.clone();
    const accusers: number[] = [];
    for (let i = 0; i < N; i++) {
      const b = this.bots[i];
      if (!b) continue;
      b.showRole = "none";
      b.showPos = undefined;
      b.showPush = undefined;
      b.showPushStart = undefined;
      b.showYaw = undefined;
      b.showSpeed = undefined;
      b.showArrived = false;
      b.revealPending = false;
      if (i !== ins && !v.seats[i]?.empty && v.votes?.[i] === ins) accusers.push(i);
    }
    this.showAccusers = accusers;
    const angles = this.showdownAngles(insPos, ins, accusers);
    const instant = this.quality === 0 || this.reducedMotion;

    // Insider bot setup
    insBot.yaw = Math.PI;
    insBot.root.rotation.y = Math.PI;
    insBot.moving = false;
    this.express(insBot, v.caught ? "Angry" : null);
    if (v.caught) {
      if (instant) {
        this.cagePending = false;
        this.cage.visible = true;
        this.cage.position.set(insPos.x, 0, insPos.z);
        this.cageSlammed = true;
        this.play(insBot, "Sitting", true, true);
        sfx.clang();
      } else {
        this.cagePending = true;
        this.cage.visible = false;
        this.cageSlammed = false;
        this.play(insBot, "No", true);
      }
    } else {
      this.cagePending = false;
      this.cage.visible = false;
      if (accusers.length === 0 || instant) {
        this.play(insBot, "Dance");
        this.fountain(insPos, 120, true);
        this.emitMagentaBurst(insPos, 28, false);
        if (instant && accusers.length > 0) sfx.knock();
      } else {
        this.play(insBot, "Idle");
      }
    }

    // Accusers (ring radius 1.6 facing I; 2.2 radial push target)
    let minX = insPos.x, maxX = insPos.x, maxZ = insPos.z;
    accusers.forEach((seatIdx, k) => {
      const b = this.bots[seatIdx];
      if (!b) return;
      const a = angles[k];
      const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
      const ringPos = insPos.clone().addScaledVector(dir, 1.6);
      const pushPos = insPos.clone().addScaledVector(dir, 3.8);
      pushPos.x = THREE.MathUtils.clamp(pushPos.x, -5.85, 5.85);
      pushPos.z = THREE.MathUtils.clamp(pushPos.z, -8.8, 9.1);
      const spanPt = v.caught ? ringPos : pushPos;
      minX = Math.min(minX, ringPos.x, spanPt.x);
      maxX = Math.max(maxX, ringPos.x, spanPt.x);
      maxZ = Math.max(maxZ, ringPos.z, spanPt.z);
      b.showRole = "accuser";
      b.showPos = ringPos;
      b.showPush = pushPos;
      b.showYaw = Math.atan2(insPos.x - ringPos.x, insPos.z - ringPos.z);
      const dist = ringPos.distanceTo(b.root.position);
      b.showSpeed = Math.max(4.5, dist / 0.65);
      if (instant) {
        b.root.position.copy(ringPos);
        b.yaw = b.showYaw;
        b.root.rotation.y = b.showYaw;
        b.moving = false;
        b.showArrived = true;
        this.express(b, v.caught ? null : "Sad");
        this.play(b, v.caught ? "ThumbsUp" : "Idle", false, v.caught);
      } else {
        this.express(b, null);
        if (dist > 0.04) {
          b.moving = true;
          this.play(b, "Running");
        } else {
          b.showArrived = true;
          b.moving = false;
          this.play(b, "Idle");
        }
      }
    });

    // Wrong-accusers and idle spectators
    for (let i = 0; i < N; i++) {
      if (i === ins || accusers.includes(i)) continue;
      const b = this.bots[i];
      if (!b || v.seats[i]?.empty) continue;
      const target = v.votes && i < v.votes.length ? v.votes[i] : 255;
      const wrong = target >= 0 && target < N && target !== ins && !!this.bots[target];
      b.showRole = wrong ? "wrong" : "idle";
      b.showPos = new THREE.Vector3(laneX(i) * 1.15, 0, 2.5);
      const lookPos = wrong ? this.bots[target].root.position : insPos;
      b.showYaw = Math.atan2(lookPos.x - b.showPos.x, lookPos.z - b.showPos.z);
      this.express(b, v.caught ? null : "Sad");
      if (instant) {
        b.root.position.copy(b.showPos);
        b.yaw = b.showYaw;
        b.root.rotation.y = b.showYaw;
        b.moving = false;
        b.showArrived = true;
        if (wrong) this.play(b, "No", true);
        else this.play(b, v.caught ? "ThumbsUp" : "Idle", false, v.caught);
      } else {
        b.revealPending = true;
      }
    }

    this.showCenterX = (minX + maxX) / 2;
    this.showHalfX = (maxX - minX) / 2 + (v.caught ? 1.15 : 1.75);
    this.showMaxZOff = Math.max(0, maxZ - insPos.z);
    this.showPhase = instant || accusers.length === 0 ? "done" : "charge";
  }

  private updateShowdown(v: View, re: number, raw: number) {
    const insBot = this.bots[v.insider];
    if (!insBot) return;
    const insPos = insBot.root.position;
    if (v.caught && this.cagePending && this.showAccusers.length === 0 && re >= 0.25) {
      this.cagePending = false;
      this.cage.visible = true;
      this.cage.position.set(insPos.x, this.camera.aspect < 1.25 ? 4.4 : 6.2, insPos.z);
      this.cageVy = 8.0;
      this.playSeq(insBot, ["Punch", "Punch", "Sitting"], true);
    }

    if (this.showPhase === "charge") {
      let allArrived = true;
      for (const idx of this.showAccusers) {
        const ab = this.bots[idx];
        if (!ab || !ab.showPos || ab.showArrived) continue;
        const d = ab.showPos.clone().sub(ab.root.position);
        const len = d.length();
        if (len > 0.04) {
          allArrived = false;
          const step = Math.min(len, (ab.showSpeed ?? 9) * raw);
          ab.root.position.addScaledVector(d, step / len);
          ab.yaw = Math.atan2(d.x, d.z);
          if (!ab.moving) { ab.moving = true; this.play(ab, "Running"); }
          ab.lean += (0.14 - ab.lean) * Math.min(1, raw * 12);
        } else {
          ab.root.position.copy(ab.showPos);
          ab.showArrived = true;
          ab.moving = false;
          ab.lean = 0;
          ab.yaw = ab.showYaw ?? Math.PI;
          this.play(ab, "Idle");
        }
      }
      if ((allArrived && re >= 0.68) || re >= 0.90) {
        for (const idx of this.showAccusers) {
          const ab = this.bots[idx];
          if (ab && ab.showPos) {
            ab.root.position.copy(ab.showPos);
            ab.showArrived = true;
            ab.moving = false;
            ab.lean = 0;
            ab.yaw = ab.showYaw ?? Math.PI;
          }
        }
        if (v.caught) {
          this.showPhase = "done";
          if (this.cagePending) {
            this.cagePending = false;
            this.cage.visible = true;
            this.cage.position.set(insPos.x, this.camera.aspect < 1.25 ? 4.4 : 6.2, insPos.z);
            this.cageVy = 8.0;
            this.playSeq(insBot, ["Punch", "Punch", "Sitting"], true);
          }
        } else {
          this.showPhase = "knock";
          this.showKnockAt = re;
          sfx.knock();
          this.play(insBot, "Punch", true);
          (this.ringWave.material as THREE.MeshBasicMaterial).color.set(MAGENTA);
          this.ringWave.position.set(insPos.x, 0.06, insPos.z);
          this.ringWaveStrong = true;
          this.ringWaveT = 0;
          this.emitMagentaBurst(insPos, 36, true);
          for (const idx of this.showAccusers) {
            const ab = this.bots[idx];
            if (!ab) continue;
            ab.showPushStart = ab.root.position.clone();
            this.express(ab, "Sad");
            this.play(ab, "Death", true, true);
          }
        }
      }
    } else if (this.showPhase === "knock") {
      const ke = re - this.showKnockAt;
      const u = Math.min(1, ke / 0.35);
      const ease = 1 - Math.pow(1 - u, 3);
      for (const idx of this.showAccusers) {
        const ab = this.bots[idx];
        if (!ab) continue;
        if (ab.showPushStart && ab.showPush) ab.root.position.lerpVectors(ab.showPushStart, ab.showPush, ease);
        ab.yaw = ab.showYaw ?? Math.PI;
        ab.lean += (0 - ab.lean) * Math.min(1, raw * 10);
      }
      if (ke >= 0.35 && !this.showDanceDone) {
        this.showDanceDone = true;
        this.play(insBot, "Dance");
        this.fountain(insPos, 120, true);
        this.emitMagentaBurst(insPos, 28, false);
      }
      if (ke >= 1.15 && !this.showStandDone) {
        this.showStandDone = true;
        this.showPhase = "done";
        for (const idx of this.showAccusers) {
          const ab = this.bots[idx];
          if (!ab) continue;
          ab.hold = false;
          ab.holdEnd = false;
          ab.queue = [];
          this.play(ab, "Standing", true, false, 1.6);
        }
      }
    }
  }

  set(v: View) {
    if (import.meta.env.DEV && this.showLock) return;
    const prev = this.view;
    this.view = v;
    if (v.stage !== "vote" || v.canVote === false) { this.hot = -1; this.renderer.domElement.style.cursor = ""; }
    if (!this.ready) { this.drawWall(v.wall, v.stage); return; }
    const changed = prev?.stage !== v.stage;
    if (changed) {
      this.stageAt = this.clock.elapsedTime;
      if (v.stage !== "reveal") {
        this.showInit = false;
        this.showPhase = "idle";
        this.cagePending = false;
        this.cage.visible = false;
        this.showAccusers = [];
      } else {
        for (const coin of this.coins) coin.life = 0;
        this.cageSlammed = false;
        this.cageVy = 0;
        this.payoutDone = false;
      }
      if (prev && !this.orbit) {
        this.camFromPos.copy(this.camera.position);
        this.camFromLook.copy(this.look);
        this.camFromFov = this.fov;
        if (v.stage === "live") this.camFromPos.y = Math.max(this.camFromPos.y, 13.5);
        this.transT = 0;
        this.transDur = v.stage === "live" ? 1.1 : v.stage === "reveal" ? 0.8 : 1.0;
      }
      if (v.stage !== "vote") {
        this.accused = -1;
        this.laserSeat = -1;
        this.accusedAllIn = false;
        this.laserFlare = 0;
      }
    }
    const wantAllIn = !!v.allIn;
    if (v.stage === "vote" && typeof v.accused === "number" && v.accused >= 0 && (v.accused !== this.laserSeat || wantAllIn !== this.accusedAllIn) && this.bots[v.accused]) {
      this.accused = v.accused;
      this.laserSeat = v.accused;
      this.accusedAllIn = wantAllIn;
      this.laserFlare = 1;
      const b = this.bots[v.accused];
      this.play(b, "No", true);
      if (this.quality > 0) {
        const chest = b.root.position.clone().add(new THREE.Vector3(0, 1.05, 0.3));
        this.emit(wantAllIn ? 32 : 16, (pt) => {
          pt.p.copy(chest);
          pt.v.set((Math.random() - 0.5) * 4, 1 + Math.random() * 3, (Math.random() - 0.2) * 3.5);
          pt.col.set(wantAllIn ? 0xff6230 : 0xff2846);
          pt.maxLife = pt.life = 0.35 + Math.random() * 0.2;
          pt.size = wantAllIn ? 1.4 : 1.0;
          pt.grav = 4; pt.drag = 0.94; pt.grow = -0.3;
        });
      }
    }
    if (v.stage === "reveal" && v.scores && !this.payoutDone) {
      this.payoutDone = true;
      this.launchPayouts(v.scores);
    }
    this.tiltTo = v.stage === "live" ? THREE.MathUtils.clamp((v.wall.shocks.reduce((a, s) => a + (Math.abs(s.bps) > 1 ? s.bps : 0), 0) / 250) * 2.2, -7, 7) * (Math.PI / 180) : 0;
    this.nearGate.visible = !this.lined(v.stage);
    if (v.stage !== "reveal") this.cage.visible = false;
    let longs = 0, shorts = 0;
    this.bots.forEach((b, i) => {
      const s = v.seats[i], col = this.col.set(this.colors[i]);
      if (!s.empty && v.stage === "live") { if (s.pos > 0) longs++; else if (s.pos < 0) shorts++; }
      if (v.stage !== "reveal") b.body.visible = !s.empty;
      const rm = b.ring.material as THREE.MeshBasicMaterial;
      rm.opacity = i === v.me ? 0.95 : 0;
      b.ring.visible = rm.opacity > 0.01;
      rm.color.set(i === v.me && v.insiderMe ? MAGENTA : col);
      if (b.mask) b.mask.visible = v.stage === "reveal" && i === v.insider;
      if (changed || (v.stage !== "reveal" && prev?.seats[i].empty !== s.empty)) {
        b.main.color.copy(col);
        b.main.emissive.set(0);
        b.down = 0;
        b.slump = 0;
        b.queue = [];
        b.holdEnd = false;
        b.nervous = false;
        b.dealDone = false;
        b.revealPending = false;
        this.express(b, null);
        if (v.stage !== "reveal") {
          if (!b.moving) this.play(b, "Idle");
          if (v.stage === "deal") this.play(b, "Standing", true, true);
          if (v.stage === "drum") this.express(b, "Surprised");
        }
      } else if (v.stage === "live" && b.current === "Idle" && b.slump <= 0) this.express(b, s.mood < 0 ? "Sad" : null);
    });
    if (v.stage === "reveal" && !this.showInit) this.setupShowdown(v);
    this.longGateMat.emissiveIntensity = 1.15 + longs * 0.35;
    this.shortGateMat.emissiveIntensity = 1.15 + shorts * 0.35;
    this.longChevMat.opacity = Math.min(0.9, 0.24 + longs * 0.13);
    this.shortChevMat.opacity = Math.min(0.85, 0.22 + shorts * 0.12);
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
    this.host.dataset.q = String(q);
    this.renderer.shadowMap.enabled = q >= 2;
    this.key.castShadow = q >= 2;
    for (const s of this.beamShadows) s.castShadow = q >= 2;
    this.audience.count = q >= 2 ? AUDIENCE_MAX : q === 1 ? Math.floor(AUDIENCE_MAX / 2) : Math.floor(AUDIENCE_MAX / 3);
    for (const b of this.beams) {
      b.cone.visible = q > 0;
      if (b.spot) b.spot.intensity = q > 0 ? 32 : 0;
    }
    const chestGlow = q >= 2 ? 1.6 : q === 1 ? 0.7 : 0;
    for (const bot of this.bots) if (bot.chestMat) bot.chestMat.emissiveIntensity = chestGlow;
    const cap = this.maxParticles();
    this.ptMesh.count = cap;
    if (q === 0) {
      for (let i = 0; i < PARTICLE_CAP; i++) {
        this.particles[i].life = 0;
        this.tmp.scale.setScalar(0); this.tmp.updateMatrix();
        this.ptMesh.setMatrixAt(i, this.tmp.matrix);
      }
      this.ptMesh.instanceMatrix.needsUpdate = true;
      this.ptMesh.visible = false;
      this.ptActive = false;
      this.ripples = [];
      this.ringWave.visible = false;
      this.rumourSweepMesh.visible = false;
      this.laserA.visible = this.laserB.visible = false;
      this.host.classList.remove("fx-last10");
    }
    this.deckMat.normalMap = q > 0 ? this.brushedNormal : null;
    this.deckMat.needsUpdate = true;
    this.bloom.enabled = q > 0;
    this.bloom.strength = q >= 2 ? 0.58 : q === 1 ? 0.26 : 0;
    const dpr = q >= 2 ? Math.min(devicePixelRatio, 2) : q === 0 && this.lowDpr ? 0.75 : 1;
    this.renderer.setPixelRatio(dpr);
    this.composer.setPixelRatio(dpr);
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
  private lowDpr = false;
  private lowFpsSecs = 0;
  private frames = 0;
  private spent = 0;
  private warmupFrames = 0;
  private badWindows = 0;
  private targetFov = 50;
  /// Renderer facts for the proof panel and QA.
  stats() { const i = this.renderer.info; return { quality: this.quality, calls: i.render.calls, triangles: i.render.triangles, ratio: this.renderer.getPixelRatio() }; }
  private click = (e: MouseEvent) => {
    const s = this.pick(e);
    if (s >= 0 && this.view?.stage === "vote" && this.view.canVote !== false && s !== this.view.me && !this.view.seats[s].empty) {
      this.accused = s;
      if (this.bots[s]) this.play(this.bots[s], "No", true);
      this.onPick(s);
    }
  };
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
    this.vaultTag.visible = !(portrait && (stage === "live" || stage === "vote" || stage === "reveal"));
    const meX = v && v.me >= 0 ? laneX(v.me) : 0, me = v && v.me >= 0 ? this.bots[v.me] : undefined;
    let fov = 50;
    this.overheadTruss.visible = stage !== "live" || portrait;
    this.overheadGoldTruss.visible = stage !== "live" || portrait;
    if (this.orbit) {
      const sw = Math.sin(t * 0.14) * 0.65;
      if (portrait) {
        this.camPos.set(Math.sin(sw) * 16 * a, 9.2, Math.cos(sw) * 17 * a);
        this.camLook.set(0, 2.2, -2.5);
      } else {
        this.camPos.set(Math.sin(sw) * 12, 13.8, Math.cos(sw) * 19.2);
        this.camLook.set(0, -1.0, 1.0);
        fov = 44;
      }
    } else if (stage === "live") {
      const last = v!.wall.elapsed >= 50, z = me ? Math.max(0, me.root.position.z) * 0.06 : 0;
      if (portrait) {
        fov = last ? 39 : 38;
        this.camPos.set(0, last ? 9.6 : 9.9, 23.2 + z * 0.4);
        this.camLook.set(0, 1.15, 0);
      } else {
        const camZ = 47 + z, camY = 3.5, targetZ = -1.5;
        fov = last ? 22.2 : 22;
        const game = this.host.closest(".game");
        const tray = game?.querySelector<HTMLElement>(".tray");
        const bar = game?.querySelector<HTMLElement>(".bar");
        const width = this.host.clientWidth || window.innerWidth;
        const height = this.host.clientHeight || window.innerHeight;
        const hostTop = this.host.getBoundingClientRect().top;
        const trayTop = tray?.getBoundingClientRect().top ?? hostTop + height - 140;
        const barBottom = bar?.getBoundingClientRect().bottom ?? hostTop;
        const key = `${width}:${height}:${trayTop}:${barBottom}:${last}`;
        if (key !== this.liveFrameKey) {
          this.liveFrameKey = key;
          const tanHalfFov = Math.tan((fov * Math.PI) / 360);
          const projectedY = (x: number, y: number, pointZ: number, lookY: number) => {
            const fy0 = lookY - camY, fz0 = targetZ - camZ;
            const fd = Math.hypot(fy0, fz0), fy = fy0 / fd, fz = fz0 / fd;
            const dy = y - camY, dz = pointZ - camZ;
            const depth = dy * fy + dz * fz;
            const vertical = dy * -fz + dz * fy;
            return hostTop + height / 2 - vertical * height / (2 * tanHalfFov * depth);
          };
          const bounds = (lookY: number) => {
            const signYs = [];
            const halfH = 0.9 * 0.85 / 2;
            const halfD = Math.sin(Math.PI / 2.8) * halfH;
            const halfY = Math.cos(Math.PI / 2.8) * halfH;
            for (const y of [0.24 - halfY, 0.24 + halfY]) for (const pointZ of [9.48 - halfD, 9.48 + halfD]) {
              signYs.push(projectedY(0, y, pointZ, lookY));
            }
            const edgeYs = [-6.45, 6.45].map((x) => projectedY(x, 0.045, 9.6, lookY));
            const wallTop = [ -6.8, 6.8 ].flatMap((x) => [projectedY(x, 10.25, -12.6, lookY)]);
            return { near: Math.max(...signYs, ...edgeYs), wall: Math.min(...wallTop) };
          };
          const nearLimit = trayTop - 24;
          let low = -20, high = 3.5;
          if (bounds(high).near <= nearLimit) low = high;
          else for (let i = 0; i < 24; i++) {
            const mid = (low + high) / 2;
            if (bounds(mid).near <= nearLimit) low = mid; else high = mid;
          }
          const wallLimit = barBottom + 8;
          if (bounds(low).wall < wallLimit) {
            let lo = low, hi = 3.5;
            for (let i = 0; i < 24; i++) {
              const mid = (lo + hi) / 2;
              if (bounds(mid).wall >= wallLimit) hi = mid; else lo = mid;
            }
            low = hi;
          }
          this.liveLookY = low;
        }
        this.camPos.set(meX * 0.12, camY, camZ);
        this.camLook.set(meX * 0.08, this.liveLookY, targetZ);
      }
    } else if (stage === "deal" && me) {
      this.camPos.set(meX + 1.6, 2.3, -4.6 * a);
      this.camLook.set(meX, 1.4, 0);
    } else if (stage === "vote" || stage === "drum") {
      const portraitVote = portrait && stage === "vote";
      const portraitDrum = portrait && stage === "drum";
      fov = portraitVote ? 55 : portraitDrum ? 56 : 52;
      const minDz = (portrait ? 7.65 : 6.3) / (Math.tan((fov * Math.PI) / 360) * aspect);
      const dolly = stage === "vote" ? Math.sin((t - this.stageAt) * 0.28) * 1.6 : 0;
      const focus = this.hot >= 0 ? laneX(this.hot) * 0.35 : dolly * 0.65;
      const targetZ = 6.6;
      this.camPos.set(focus, portraitVote ? 3.55 : portraitDrum ? 2.9 : 2.65, 7.2 + Math.max(9.6, minDz));
      this.camLook.set(
        dolly * 0.35 + (this.hot >= 0 ? laneX(this.hot) * 0.15 : 0),
        portraitVote ? 3.35 : portraitDrum ? 2.45 : 2.1,
        targetZ,
      );
    } else if (stage === "reveal" && this.bots[v!.insider]) {
      const p = this.bots[v!.insider].root.position;
      const el = t - this.stageAt;
      const orbitAngle = Math.max(0, el - 0.85) * 0.28;
      const orbitPan = Math.sin(orbitAngle) * (portrait ? 0.15 : 1.45);
      const wideEscape = !v!.caught && this.showAccusers.length > 0;
      fov = portrait ? (wideEscape ? 62 : 54) : 54;
      const spanBack = portrait ? this.showHalfX / (Math.tan((fov * Math.PI) / 360) * aspect) + this.showMaxZOff : 0;
      const centerX = portrait && this.showAccusers.length > 0 ? this.showCenterX : portrait ? p.x : p.x * 0.62;
      const camX = centerX + orbitPan;
      const back = portrait ? Math.max(wideEscape ? 14.5 : 11.4, spanBack) : 9.4;
      this.camPos.set(camX, portrait ? (wideEscape ? 4.2 : 3.3) : 2.85, p.z + back);
      this.camLook.set(portrait ? centerX : p.x * 0.48, portrait ? (wideEscape ? 1.35 : 1.55) : 2.0, p.z);
    } else {
      this.camPos.set(Math.sin(t * 0.2) * 2.5, 6.2, 15 * a);
      this.camLook.set(0, 3.6, -4);
    }
    if (!this.reducedMotion && this.shockPush > 0.001 && stage === "live") {
      this.camPos.lerp(this.camLook, 0.09 * Math.min(2, this.shockPush));
    }
    this.targetFov = !this.reducedMotion && this.flash > 0.75 ? fov - 3 : fov;
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
    const k = 1 - Math.exp(-raw * (stage === "idle" ? 1.5 : 3.5));
    if (this.transT < 1) {
      if (stage === "reveal" && this.camera.aspect < 1.25) {
        this.transT = 1;
        this.camera.position.copy(this.camPos);
        this.look.copy(this.camLook);
        this.fov = this.targetFov;
      } else {
        this.transT = Math.min(1, this.transT + raw / this.transDur);
        const e = this.transT * this.transT * (3 - 2 * this.transT);
        this.camera.position.lerpVectors(this.camFromPos, this.camPos, e);
        this.look.lerpVectors(this.camFromLook, this.camLook, e);
        this.fov = THREE.MathUtils.lerp(this.camFromFov, this.targetFov, e);
      }
    } else {
      this.camera.position.lerp(this.camPos, k);
      this.look.lerp(this.camLook, k);
      this.fov += (this.targetFov - this.fov) * 0.14;
    }
    this.shockPush = this.reducedMotion ? 0 : Math.max(0, this.shockPush - raw * 0.75);
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

    const lobbyDim = this.orbit ? 0.22 : 1;
    this.flash = this.reducedMotion ? 0 : Math.max(0, this.flash - raw * 0.9);
    this.amb.intensity += (((stage === "vote" ? 0.5 : dark ? 0.18 : 0.65) * (this.orbit ? 0.58 : 1)) - this.amb.intensity) * k;
    this.key.intensity += (((dark ? 0.15 : last ? 0.75 : 1.35) * (this.orbit ? 0.68 : 1)) - this.key.intensity) * k;
    const cyc = last ? v!.wall.elapsed % 1 : 0;
    const beat = last && !this.reducedMotion && this.quality > 0
      ? Math.min(1, Math.exp(-Math.pow((cyc - 0.12) / 0.075, 2)) + 0.72 * Math.exp(-Math.pow((cyc - 0.34) / 0.075, 2)))
      : 0;
    this.host.classList.toggle("fx-last10", last && !this.reducedMotion && this.quality > 0);
    this.alarm.color.set(0xff3030);
    if (this.flash > 0) this.alarm.color.copy(this.flashColor);
    this.alarm.intensity = this.reducedMotion ? 0 : this.flash * 420 + beat * 180 + (stage === "drum" ? (Math.sin(t * 14) > 0 ? 120 : 0) : 0);
    this.wallMat.color.setScalar((dark ? 0.45 : 1) * lobbyDim).lerp(this.flashColor, this.flash * 0.5);
    this.tickerMat.color.setScalar(lobbyDim);
    this.vaultTagMat.opacity = this.orbit ? 0.1 : 1;
    const baseBloom = this.quality >= 2 ? 0.58 : this.quality === 1 ? 0.26 : 0;
    this.bloom.strength = this.orbit ? 0.12 : baseBloom + this.flash * 0.4 + (stage === "reveal" ? 0.18 : 0);

    // Rumour: soft amber sweep across the jumbotron without shake.
    if (this.rumourSweep > 0 && this.quality > 0 && !this.reducedMotion) {
      this.rumourSweep = Math.max(0, this.rumourSweep - raw * 1.05);
      this.rumourSweepMesh.visible = true;
      this.rumourSweepMesh.position.x = (1 - this.rumourSweep * 2) * 5.4;
      (this.rumourSweepMesh.material as THREE.MeshBasicMaterial).opacity = Math.sin(this.rumourSweep * Math.PI) * 0.72 * (this.quality === 1 ? 0.6 : 1);
    } else {
      this.rumourSweep = 0;
      this.rumourSweepMesh.visible = false;
    }

    // Vault rotation & glow (brighter during deal and reveal, dimmed when lobby backdrop).
    const vaultHot = !this.orbit && (stage === "deal" || stage === "reveal");
    this.vault.rotation.y += raw * (stage === "deal" ? 4.2 : 0.35);
    this.vaultCore.rotation.x += raw * (vaultHot ? 2.6 : 1.3);
    this.vaultRings[0].rotation.z += raw * (vaultHot ? 2.4 : 0.9);
    this.vaultRings[1].rotation.y -= raw * (vaultHot ? 2.8 : 1.1);
    this.vaultLight.intensity += ((this.orbit ? 1.2 : vaultHot ? 28 : 10) - this.vaultLight.intensity) * Math.min(1, raw * 6);
    this.vaultEdgeMat.color.set(MAGENTA).multiplyScalar(this.orbit ? 0.26 : vaultHot ? 1.7 : 1.0);

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

    // Moving-head beams: sweep in idle & drum roll, lock onto gates in live, red in last 10s, focus reveal/vote.
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
          mb.mat.opacity = 0.2;
        } else if (stage === "drum") {
          const sweepX = Math.sin(t * 7.2 + idx * 1.55) * 6.5;
          tgt.set(sweepX, 0.8, 6.6);
          mb.mat.color.set(idx % 2 === 0 ? GOLD : MAGENTA);
          mb.mat.opacity = this.quality >= 2 ? 0.26 : 0.15;
        } else if (stage === "vote") {
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
          mb.spot.intensity = stage === "live" && last ? 46 : stage === "drum" ? 44 : 32;
        }
      });
    }

    // Update tile ripples expanding outward two tiles + heartbeat brightness pulse in last 10 s.
    for (let r = this.ripples.length - 1; r >= 0; r--) {
      this.ripples[r].t += raw;
      if (this.ripples[r].t >= this.ripples[r].dur) this.ripples.splice(r, 1);
    }

    // Tiles: preserve each seat's lane colour across both halves while grading LONG green vs SHORT crimson.
    const tip = v?.insiderMe && stage === "live" ? v.wall.future.find((s) => s.at - v.wall.elapsed > 0 && s.at - v.wall.elapsed < 6) : undefined;
    const seatBase = new THREE.Color(), dirTint = new THREE.Color(), beatTint = new THREE.Color(0xff3048);
    const qScale = this.quality >= 2 ? 1 : this.quality === 1 ? 0.5 : 0;
    for (let i = 0; i < N; i++) {
      seatBase.set(this.colors[i]);
      for (let p = -5; p <= 5; p++) {
        const s = v?.seats[i], on = s && !s.empty && s.pos === p && !dark;
        if (on) {
          this.col.copy(seatBase).multiplyScalar(1.08 + beat * 0.2 * qScale);
        } else if (p === 0) {
          this.col.copy(seatBase).multiplyScalar(dark ? 0.025 : 0.14).lerp(dirTint.set(0x162040), 0.5);
          if (!dark && beat > 0) this.col.lerp(beatTint, beat * 0.22 * qScale);
        } else {
          dirTint.set(p > 0 ? GREEN : 0xd61e34);
          this.col.copy(seatBase).lerp(dirTint, p > 0 ? 0.42 : 0.36);
          const amp = dark ? 0.018 : 0.11 + Math.abs(p) * 0.024 + this.flash * 0.15 + beat * 0.26 * qScale;
          this.col.multiplyScalar(amp);
          if (!dark && beat > 0) this.col.lerp(beatTint, beat * 0.2 * qScale);
        }
        if (!dark && qScale > 0 && this.ripples.length) {
          for (const rp of this.ripples) {
            const dist = Math.hypot(i - rp.seat, p - rp.p);
            if (dist <= 2.2) {
              const prog = rp.t / rp.dur;
              const ringR = prog * 2.15;
              const wave = Math.exp(-Math.pow((dist - ringR) * 1.9, 2)) * (1 - prog);
              if (wave > 0.02) this.col.lerp(rp.col, Math.min(0.95, wave * 1.05 * qScale));
            }
          }
        }
        if (tip && i === v!.me && Math.sign(p) === Math.sign(tip.bps) && !on) this.col.lerp(new THREE.Color(MAGENTA), 0.25 + 0.25 * Math.sin(t * 9));
        this.tiles.setColorAt(i * 11 + p + 5, this.col);
      }
    }
    this.tiles.instanceColor!.needsUpdate = true;

    let chosen = -1;
    const tagEls = this.tags();
    if (stage === "vote") {
      const domAcc = tagEls.findIndex((el) => !!el?.querySelector(".tag-mark"));
      if (domAcc >= 0 && domAcc !== this.accused && this.bots[domAcc]) {
        this.accused = domAcc;
        this.play(this.bots[domAcc], "No", true);
      }
    }
    if (stage === "reveal" && v && this.showInit) this.updateShowdown(v, t - this.stageAt, raw);
    const pendingTags: { el: HTMLElement; px: number; py: number; hw: number; h: number }[] = [];
    this.bots.forEach((b, i) => {
      b.mixer.update(dt);
      const s = v?.seats[i];
      b.down = Math.max(0, b.down - dt);
      b.slump = Math.max(0, b.slump - dt);
      if (b.down === 0 && b.current === "Death" && stage === "live") { this.play(b, "Idle"); this.express(b, "Sad"); }
      if (v && s && b.body.visible && b.down === 0 && !(stage === "reveal" && (i === v.insider || b.showRole === "accuser"))) {
        const to = stage === "reveal" && b.showPos ? b.showPos.clone() : this.spot(i, v), d = to.sub(b.root.position), len = d.length();
        if (len > 0.04) {
          if (!b.moving) b.moveDist = len;
          const runMove = dark || b.moveDist >= TILE * 1.5;
          const step = Math.min(len, (dark ? 10 : runMove ? 8.5 : 5.8) * real);
          b.root.position.addScaledVector(d, step / len);
          b.yaw = Math.atan2(d.x, d.z);
          b.trail += step;
          if (stage === "live" && b.trail > 0.75) { b.trail = 0; this.print(b.root.position, i); }
          if (!b.moving) { b.moving = true; this.play(b, runMove ? "Running" : "Walking"); }
          b.lean += ((runMove ? 0.14 : 0.08) - b.lean) * Math.min(1, raw * 12);
        } else {
          if (b.moving) {
            b.moving = false;
            if (b.revealPending && v?.stage === "reveal") {
              b.revealPending = false;
              if (b.showRole === "wrong") this.play(b, "No", true);
              else if (v.caught) this.playSeq(b, ["Jump", "ThumbsUp"]);
              else this.play(b, "Idle");
            } else {
              this.play(b, "Idle", false, false, b.nervous ? 1.3 : 1);
            }
          } else if (b.revealPending && v?.stage === "reveal") {
            b.revealPending = false;
            if (b.showRole === "wrong") this.play(b, "No", true);
            else if (v.caught) this.playSeq(b, ["Jump", "ThumbsUp"]);
            else this.play(b, "Idle");
          }
          b.lean += (0 - b.lean) * Math.min(1, raw * 10);
          if (stage === "reveal" && b.showYaw !== undefined) {
            b.yaw = b.showYaw;
          } else {
            let idleYaw = dark ? 0 : Math.PI;
            if (!dark && t > b.nextGlance) b.nextGlance = t + 3.2 + Math.random() * 4.5;
            if (!dark && this.lastTrader >= 0 && this.lastTrader !== i && t - this.glanceAt < 1.5 && this.bots[this.lastTrader]) {
              const oPos = this.bots[this.lastTrader].root.position;
              const toOther = Math.atan2(oPos.x - b.root.position.x, oPos.z - b.root.position.z);
              const deltaY = Math.atan2(Math.sin(toOther - Math.PI), Math.cos(toOther - Math.PI));
              idleYaw = Math.PI + THREE.MathUtils.clamp(deltaY, -0.65, 0.65);
            }
            b.yaw = idleYaw;
          }
        }
      } else {
        b.lean += (0 - b.lean) * Math.min(1, raw * 10);
      }
      b.body.rotation.x = b.lean;
      if (b.neck && b.slump > 0 && b.current === "Idle" && !b.moving) {
        b.neck.rotation.x += 0.42;
      }
      let dy = b.yaw - b.root.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      b.root.rotation.y += dy * Math.min(1, raw * 14);

      const pm = b.pulse.material as THREE.MeshBasicMaterial;
      if (pm.opacity > 0) { pm.opacity = Math.max(0, pm.opacity - raw * 2.2); b.pulse.scale.multiplyScalar(1 + raw * 4); }
      b.pulse.visible = pm.opacity > 0.01;
      b.ring.scale.setScalar(1 + Math.sin(t * 3) * 0.05);

      const world = b.root.getWorldPosition(new THREE.Vector3());
      const spotFocus = stage === "vote" && (this.hot === i || (this.hot < 0 && this.accused === i));
      const lit = !b.body.visible ? 0 : stage === "vote" ? (spotFocus ? 95 : 45) : stage === "drum" ? (Math.floor(t * 9) % N === i ? 90 : 3) : stage === "reveal" ? (i === v!.insider ? 110 : 0) : 0;
      if (lit > 80) { chosen = i; this.spotL.position.set(world.x, 11, world.z + 3); this.spotL.target = b.root; this.spotL.color.set(stage === "reveal" ? MAGENTA : 0xffffff); }
      if (stage === "vote" && !b.moving && b.queue.length === 0 && b.current !== "No") {
        if (lit > 80 && !b.nervous) {
          b.nervous = true;
          this.express(b, "Surprised");
          if (i % 2 === 0) this.play(b, "Wave", true);
          else this.play(b, "Idle", false, false, 1.3);
        } else if (lit <= 80 && b.nervous) {
          b.nervous = false;
          this.express(b, null);
          if (b.current === "Idle") b.actions.Idle.timeScale = 1;
        }
      }

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
        if (!b.dealDone && bm.opacity >= 0.85) { b.dealDone = true; this.play(b, "Yes", true); }
      }

      const el = tagEls[i];
      if (el) {
        const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
        const narrow = w < 700;
        const yOff = narrow && (stage === "live" || stage === "vote") && i % 2 === 1 ? 2.65 : 2.15;
        const p = world.clone().setY(world.y + yOff).project(this.camera);
        const vis = p.z < 1 && stage !== "reveal";
        el.style.opacity = vis ? "1" : "0";
        if (vis) {
          const hw = Math.max(18, (el.offsetWidth || 48) / 2);
          const th = Math.max(18, el.offsetHeight || 26);
          const px = THREE.MathUtils.clamp(((p.x + 1) / 2) * w, hw + 4, w - hw - 4);
          let py = ((1 - p.y) / 2) * h;
          if (narrow && i % 2 === 1) py -= th + 4;
          pendingTags.push({ el, px, py: THREE.MathUtils.clamp(py, th + 4, h - 4), hw, h: th });
        }
      }
    });

    if (pendingTags.length) {
      const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
      const placedRects: { px: number; py: number; hw: number; h: number }[] = [];
      const overlaps = (a: { px: number; py: number; hw: number; h: number }, b: { px: number; py: number; hw: number; h: number }) =>
        Math.abs(a.px - b.px) < a.hw + b.hw + 4 && a.py > b.py - b.h - 4 && a.py - a.h < b.py + 4;
      for (const item of [...pendingTags].sort((a, b) => b.py - a.py)) {
        item.py = THREE.MathUtils.clamp(item.py, item.h + 4, h - 4);
        for (let pass = 0; pass < 8; pass++) {
          const hit = placedRects.find((r) => overlaps(item, r));
          if (!hit) break;
          const upY = hit.py - hit.h - 4;
          if (upY >= item.h + 4) { item.py = upY; continue; }
          const downY = hit.py + item.h + 4;
          if (downY <= h - 4) { item.py = downY; continue; }
          const shiftR = hit.px + hit.hw + item.hw + 5;
          const shiftL = hit.px - hit.hw - item.hw - 5;
          item.px = shiftR <= w - item.hw - 4 ? shiftR : Math.max(item.hw + 4, shiftL);
        }
        placedRects.push(item);
        item.el.style.transform = `translate(-50%,-100%) translate(${item.px.toFixed(1)}px,${item.py.toFixed(1)}px)`;
      }
    }

    this.spotL.intensity += ((chosen >= 0 ? 68 : 0) - this.spotL.intensity) * Math.min(1, raw * 8);
    let printsDirty = false;
    for (let i = 0; i < this.prints.length; i++) {
      const f = this.prints[i];
      if (f.life <= 0) continue;
      printsDirty = true;
      f.life -= dt / 10;
      if (f.life <= 0 || stage !== "live") {
        f.life = 0;
        this.tmp.position.set(f.x, -10, f.z);
        this.tmp.scale.setScalar(0);
      } else {
        this.tmp.position.set(f.x, 0.02, f.z);
        this.tmp.rotation.set(0, 0, 0);
        this.tmp.scale.setScalar(0.55 + f.life * 0.45);
        this.printMesh.setColorAt(i, this.col.set(this.colors[f.seat]).multiplyScalar(Math.max(0.1, f.life)));
      }
      this.tmp.updateMatrix();
      this.printMesh.setMatrixAt(i, this.tmp.matrix);
    }
    if (printsDirty) {
      this.printMesh.instanceMatrix.needsUpdate = true;
      if (this.printMesh.instanceColor) this.printMesh.instanceColor.needsUpdate = true;
    }
    let anyCoin = false;
    this.coins.forEach((c, i) => {
      if (c.life <= 0) return;
      anyCoin = true;
      if (c.src && c.dst && c.dur) {
        if (c.delay && c.delay > 0) {
          c.delay = Math.max(0, c.delay - raw);
          c.life -= raw;
          this.tmp.scale.setScalar(0); this.tmp.updateMatrix();
          this.coinMesh.setMatrixAt(i, this.tmp.matrix);
          return;
        }
        c.t = (c.t ?? 0) + raw;
        const p = Math.min(1, c.t / c.dur);
        c.p.lerpVectors(c.src, c.dst, p);
        c.p.y += Math.sin(p * Math.PI) * (c.arcH ?? 2.0);
        if (p >= 1) {
          c.life = 0;
          if (c.spark && this.quality > 0) {
            this.emit(5, (pt) => {
              pt.p.copy(c.dst!);
              pt.v.set((Math.random() - 0.5) * 2.4, 1.5 + Math.random() * 2.2, (Math.random() - 0.5) * 2.4);
              pt.col.set(c.spark!);
              pt.maxLife = pt.life = 0.28 + Math.random() * 0.15;
              pt.size = 0.85; pt.grav = 5; pt.drag = 0.94; pt.grow = -0.3;
            });
          }
          this.tmp.scale.setScalar(0); this.tmp.updateMatrix();
          this.coinMesh.setMatrixAt(i, this.tmp.matrix);
          return;
        }
        c.life -= raw;
      } else {
        c.life -= dt;
        c.v.y -= 14 * dt;
        c.p.addScaledVector(c.v, dt);
        if (c.p.y < 0.05 && c.v.y < 0) { c.p.y = 0.05; c.v.y *= -0.4; c.v.x *= 0.6; c.v.z *= 0.6; }
      }
      this.tmp.position.copy(c.p); this.tmp.rotation.set(t * 9 + i, i, t * 7); this.tmp.scale.setScalar(c.life > 0 ? Math.min(1, c.life * 3) : 0); this.tmp.updateMatrix();
      this.coinMesh.setMatrixAt(i, this.tmp.matrix);
    });
    this.coinMesh.visible = anyCoin;
    if (anyCoin) this.coinMesh.instanceMatrix.needsUpdate = true;

    // Pooled particle mesh update (0 draw calls when idle or quality 0).
    if (this.ptActive && this.quality > 0) {
      let still = false;
      const cap = this.maxParticles();
      const dragPow = Math.pow(0.95, raw * 60);
      for (let i = 0; i < cap; i++) {
        const pt = this.particles[i];
        if (pt.life <= 0) continue;
        pt.life -= raw;
        if (pt.life <= 0) {
          pt.life = 0;
          this.tmp.scale.setScalar(0); this.tmp.updateMatrix();
          this.ptMesh.setMatrixAt(i, this.tmp.matrix);
          continue;
        }
        still = true;
        pt.v.y -= pt.grav * raw;
        pt.v.multiplyScalar(pt.drag < 1 ? dragPow : 1);
        pt.p.addScaledVector(pt.v, raw);
        const f = pt.life / pt.maxLife;
        const sc = Math.max(0.01, pt.size * (pt.grow > 0 ? 1 + (1 - f) * pt.grow : f * 0.9 + 0.1));
        this.tmp.position.copy(pt.p);
        this.tmp.rotation.set(i * 0.7 + t * 4, i * 1.1, t * 3);
        this.tmp.scale.setScalar(sc);
        this.tmp.updateMatrix();
        this.ptMesh.setMatrixAt(i, this.tmp.matrix);
        this.col.copy(pt.col).multiplyScalar(f * 1.15);
        this.ptMesh.setColorAt(i, this.col);
      }
      this.ptMesh.visible = still;
      this.ptActive = still;
      this.ptMesh.instanceMatrix.needsUpdate = true;
      if (this.ptMesh.instanceColor) this.ptMesh.instanceColor.needsUpdate = true;
    } else {
      this.ptMesh.visible = false;
    }

    // Vote accusation red laser beams from camera side to accused robot chest.
    this.laserFlare = Math.max(0, this.laserFlare - raw * 1.6);
    if (stage === "vote" && this.laserSeat >= 0 && this.bots[this.laserSeat] && this.quality > 0) {
      const targetPos = this.bots[this.laserSeat].root.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 1.05, 0.25));
      const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      const startA = this.camera.position.clone().addScaledVector(camRight, -1.6).addScaledVector(camUp, -0.7).addScaledVector(camFwd, 1.5);
      const lenA = startA.distanceTo(targetPos);
      this.laserA.visible = true;
      this.laserA.position.copy(startA).lerp(targetPos, 0.5);
      this.laserA.lookAt(targetPos);
      const radA = (this.quality >= 2 ? 0.028 : 0.02) + this.laserFlare * 0.022;
      this.laserA.scale.set(radA, radA, lenA);
      (this.laserA.material as THREE.MeshBasicMaterial).opacity = 0.62 + this.laserFlare * 0.35;
      if (this.accusedAllIn && this.quality >= 1) {
        const startB = this.camera.position.clone().addScaledVector(camRight, 1.65).addScaledVector(camUp, -0.55).addScaledVector(camFwd, 1.4);
        const lenB = startB.distanceTo(targetPos);
        this.laserB.visible = true;
        this.laserB.position.copy(startB).lerp(targetPos, 0.5);
        this.laserB.lookAt(targetPos);
        const radB = (this.quality >= 2 ? 0.068 : 0.048) + this.laserFlare * 0.04;
        this.laserB.scale.set(radB, radB, lenB);
        (this.laserB.material as THREE.MeshBasicMaterial).opacity = 0.72 + this.laserFlare * 0.26;
      } else {
        this.laserB.visible = false;
      }
    } else {
      this.laserA.visible = this.laserB.visible = false;
    }

    // Shock wave sweep bar + expanding ground shockwave ring.
    this.waveT += raw;
    const wm = this.wave.material as THREE.MeshBasicMaterial;
    wm.opacity = this.waveT < 0.55 ? 0.9 * (1 - this.waveT / 0.55) : 0;
    this.wave.visible = wm.opacity > 0.01;
    this.wave.position.set(0, 0.25, -9 + (this.waveT / 0.55) * 18);

    this.ringWaveT += raw;
    if (this.quality > 0 && this.ringWaveT < 0.62) {
      const rp = this.ringWaveT / 0.62;
      this.ringWave.visible = true;
      this.ringWave.scale.setScalar(1 + rp * (this.ringWaveStrong ? 17 : 12));
      (this.ringWave.material as THREE.MeshBasicMaterial).opacity = (this.ringWaveStrong ? 0.95 : 0.72) * (1 - rp) * (this.quality === 1 ? 0.6 : 1);
    } else {
      this.ringWave.visible = false;
    }

    // Reveal cage slam + base sparks on landing.
    if (this.cage.visible) {
      if (this.cage.position.y > 0) {
        this.cageVy += 44 * raw;
        this.cage.position.y = Math.max(0, this.cage.position.y - this.cageVy * raw);
      } else if (!this.cageSlammed) {
        this.cageSlammed = true;
        sfx.clang();
        if (!this.reducedMotion) this.shake = Math.max(this.shake, 0.25);
        for (const idx of this.showAccusers) {
          const ab = this.bots[idx];
          if (ab) this.playSeq(ab, ["Jump", "ThumbsUp"], true);
        }
        this.emit(44, (pt, idx) => {
          const a = (idx / 44) * Math.PI * 2 + Math.random() * 0.2;
          pt.p.set(this.cage.position.x + Math.cos(a) * 1.15, 0.12, this.cage.position.z + Math.sin(a) * 1.15);
          pt.v.set(Math.cos(a) * (3 + Math.random() * 4), 1.5 + Math.random() * 3.2, Math.sin(a) * (3 + Math.random() * 4));
          pt.col.set(idx % 3 === 0 ? GOLD : RED);
          pt.maxLife = pt.life = 0.45 + Math.random() * 0.25;
          pt.size = 1.3; pt.grav = 7; pt.drag = 0.94; pt.grow = -0.35;
        });
      }
      this.cage.rotation.y += raw * 0.6;
    }

    this.renderer.info.reset();
    this.composer.render();
    // Adaptive quality ladder: drop shadows first (Q1), then bloom/effects (Q0) keeping ratio>=1 until <30fps for 2s.
    if (this.warmupFrames < 120) {
      this.warmupFrames++;
    } else if (!document.hidden) {
      this.frames++;
      this.spent += raw;
      if (this.frames === 45) {
        const avgDt = this.spent / 45;
        if (avgDt > 1 / 30) {
          if (this.quality > 0) {
            this.badWindows++;
            if (this.badWindows >= 2) {
              this.applyQuality(this.quality - 1);
              this.badWindows = 0;
            }
          } else if (!this.lowDpr) {
            this.lowFpsSecs += this.spent;
            if (this.lowFpsSecs >= 2.0) {
              this.lowDpr = true;
              this.applyQuality(0);
            }
          }
        } else {
          this.badWindows = 0;
          this.lowFpsSecs = 0;
        }
        this.frames = 0;
        this.spent = 0;
      }
    }
  };

  private print(at: THREE.Vector3, seat: number) {
    const idx = this.printAt = (this.printAt + 1) % this.prints.length;
    const f = this.prints[idx];
    f.life = 1;
    f.x = at.x + (idx % 2 ? 0.22 : -0.22);
    f.z = at.z;
    f.seat = seat;
    this.tmp.position.set(f.x, 0.02, f.z);
    this.tmp.rotation.set(0, 0, 0);
    this.tmp.scale.setScalar(1);
    this.tmp.updateMatrix();
    this.printMesh.setMatrixAt(idx, this.tmp.matrix);
    this.printMesh.setColorAt(idx, this.col.set(this.colors[seat]));
    this.printMesh.instanceMatrix.needsUpdate = true;
    if (this.printMesh.instanceColor) this.printMesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.motionMq?.removeEventListener?.("change", this.onMotion);
    if ((window as any).__tipoffScene === this) {
      delete (window as any).__tipoffScene;
      if (import.meta.env.DEV) delete (window as any).__showdown;
    }
    this.fxEdge.remove();
    this.fxFlash.remove();
    this.fxVig.remove();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
