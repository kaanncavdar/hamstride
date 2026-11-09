import * as THREE from 'three';
import { carD, type Obs } from '../shared/course';
import { JUMP_TICKS, laneX, RIDE_BALL, RIDE_WHEEL, STUMBLE_TICKS, tired, type PState } from '../shared/sim';
import { Hamster } from './hamster';
import { beddingTex, corkTex, discTex, labelTex, softDot, treadTex, weaveTex, woodTex } from './textures';

/**
 * Each player runs inside a giant hamster wheel, seen from the front at about 45°, the way the
 * cameras watch the real WHEELY9000. The wheel turns under the hamster; what is ahead comes round
 * the rim towards it. The picture switches between a warm day look and an infrared night camera
 * every few hundred metres.
 */

/** Wheel radius and track, metres. The hamster is about 1.3 m long here: it is a big wheel. */
const R = 8;
const LANE_W = 1.4;
const DEPTH = LANE_W * 3 + 0.6;
const FLOOR_Y = -R - 0.7;
/** How far ahead (round the rim) things are drawn, and where they start growing in. */
const AHEAD = R * Math.PI * 1.32;
const GROW = 4;
/** Metres per day/night half-cycle. */
const CYCLE_M = 420;

const laneZ = (x: number) => (x - 1) * LANE_W;

/** A point on the inside of the rim, `a` metres ahead of the runner, and the turn to stand on it. */
function onRim(obj: THREE.Object3D, a: number, z: number, lift = 0) {
  const phi = a / R;
  const r = R - lift;
  obj.position.set(r * Math.sin(phi), -r * Math.cos(phi), z);
  obj.rotation.set(0, 0, phi);
}

// ---------- Shared materials ----------

let M: ReturnType<typeof makeMaterials> | null = null;
function makeMaterials() {
  const wood = new THREE.MeshStandardMaterial({ map: woodTex(), roughness: 0.75 });
  const woodDark = new THREE.MeshStandardMaterial({ color: '#7b4f2a', roughness: 0.8 });
  const cork = new THREE.MeshStandardMaterial({ map: corkTex(), roughness: 0.95 });
  const corkEnd = new THREE.MeshStandardMaterial({ color: '#d9ab73', roughness: 0.9 });
  const weave = new THREE.MeshStandardMaterial({ map: weaveTex(), roughness: 0.85 });
  const roof = new THREE.MeshStandardMaterial({ color: '#c8643b', roughness: 0.7 });
  const door = new THREE.MeshStandardMaterial({ color: '#3a2414', roughness: 1 });
  const teal = new THREE.MeshStandardMaterial({ color: '#2ec4b6', roughness: 0.35, metalness: 0.1 });
  const clear = new THREE.MeshPhysicalMaterial({ color: '#d9f3ff', roughness: 0.05, transparent: true, opacity: 0.28, depthWrite: false, clearcoat: 1 });
  const block = new THREE.MeshStandardMaterial({ color: '#4ee6ff', emissive: '#1c8fb8', emissiveIntensity: 0.9, roughness: 0.3 });
  const seed = new THREE.MeshStandardMaterial({ color: '#2b2622', roughness: 0.5 });
  const seedStripe = new THREE.MeshStandardMaterial({ color: '#efe9de', roughness: 0.5 });
  const broccoli = new THREE.MeshStandardMaterial({ color: '#4e9a3a', roughness: 0.8 });
  const stem = new THREE.MeshStandardMaterial({ color: '#9ccf6e', roughness: 0.7 });
  const courgette = new THREE.MeshStandardMaterial({ color: '#2f6b2a', roughness: 0.6 });
  const courgetteIn = new THREE.MeshStandardMaterial({ color: '#e8f0b8', roughness: 0.7 });
  const worm = new THREE.MeshStandardMaterial({ color: '#d9a55a', roughness: 0.45 });
  const glow = new THREE.SpriteMaterial({ map: softDot(), color: '#ffe9a8', transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
  return { wood, woodDark, cork, corkEnd, weave, roof, door, teal, clear, block, seed, seedStripe, broccoli, stem, courgette, courgetteIn, worm, glow };
}
export const mats = () => (M ??= makeMaterials());

export function mesh(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

// ---------- Things on the track (local: x = forward, y = towards the wheel's centre, z = across) ----------

/** A wooden hideout: too tall to jump, go round it. */
function buildHideout() {
  const m = mats();
  const g = new THREE.Group();
  const body = mesh(new THREE.BoxGeometry(2.2, 1.15, 1.15), m.wood);
  body.position.set(1.2, 0.58, 0);
  g.add(body);
  for (const s of [-1, 1]) {
    const slab = mesh(new THREE.BoxGeometry(2.4, 0.08, 0.85), m.roof);
    slab.position.set(1.2, 1.38, 0.33 * s);
    slab.rotation.x = 0.72 * s;
    g.add(slab);
  }
  const ridge = mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.45, 10), m.woodDark);
  ridge.rotation.z = Math.PI / 2;
  ridge.position.set(1.2, 1.66, 0);
  g.add(ridge);
  // The arched door faces the runner.
  const arch = new THREE.Shape();
  arch.moveTo(-0.28, 0);
  arch.lineTo(-0.28, 0.42);
  arch.absarc(0, 0.42, 0.28, Math.PI, 0, true);
  arch.lineTo(0.28, 0);
  const door = new THREE.Mesh(new THREE.ShapeGeometry(arch, 16), m.door);
  door.rotation.y = -Math.PI / 2;
  door.position.set(0.09, 0.01, 0);
  g.add(door);
  const win = new THREE.Mesh(new THREE.CircleGeometry(0.17, 20), m.door);
  win.position.set(1.4, 0.68, 0.58);
  g.add(win);
  return g;
}

/** A cork log lying across the lane: jump it. */
function buildLog() {
  const m = mats();
  const g = new THREE.Group();
  const geo = new THREE.CylinderGeometry(0.3, 0.32, 1.2, 22);
  geo.rotateX(Math.PI / 2);
  const log = mesh(geo, [m.cork, m.corkEnd, m.corkEnd]);
  log.position.set(0.3, 0.3, 0);
  log.rotation.z = 0.1;
  g.add(log);
  const knot = mesh(new THREE.SphereGeometry(0.09, 10, 8), m.cork);
  knot.position.set(0.3, 0.55, 0.25);
  g.add(knot);
  return g;
}

/** A bendy wooden bridge at head height: slide under it. */
function buildBridge() {
  const m = mats();
  const g = new THREE.Group();
  const slats = 9;
  for (let i = 0; i < slats; i++) {
    const a = Math.PI * (0.08 + (0.84 * i) / (slats - 1));
    const slat = mesh(new THREE.BoxGeometry(0.42, 0.09, 0.15), m.wood);
    slat.position.set(0.4, 0.68 + Math.sin(a) * 0.42, -Math.cos(a) * 0.62);
    slat.rotation.x = a - Math.PI / 2;
    g.add(slat);
  }
  for (const s of [-1, 1]) {
    const post = mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.85, 10), m.woodDark);
    post.position.set(0.4, 0.42, 0.64 * s);
    g.add(post);
  }
  return g;
}

/** A seagrass chew ball rolling towards you: tall, change lane. */
function buildRoller() {
  const g = new THREE.Group();
  const ball = mesh(new THREE.SphereGeometry(0.72, 28, 20), mats().weave);
  ball.position.set(1.1, 0.72, 0);
  g.add(ball);
  g.userData.roll = ball;
  return g;
}

/** Snacks: sunflower seed, broccoli, courgette slice, mealworm. */
function buildSnack(id: number) {
  const m = mats();
  const g = new THREE.Group();
  const item = new THREE.Group();
  const kind = id % 4;
  if (kind === 0) {
    const s = mesh(new THREE.SphereGeometry(0.16, 16, 12), m.seed, false);
    s.scale.set(1.5, 0.75, 0.6);
    item.add(s);
    const st = mesh(new THREE.SphereGeometry(0.162, 16, 12, 0, Math.PI * 2, 1.45, 0.12), m.seedStripe, false);
    st.scale.set(1.5, 0.75, 0.6);
    st.rotation.x = Math.PI / 2;
    item.add(st);
  } else if (kind === 1) {
    const stalk = mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.24, 8), m.stem, false);
    stalk.position.y = -0.1;
    item.add(stalk);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const f = mesh(new THREE.SphereGeometry(0.1, 10, 8), m.broccoli, false);
      f.position.set(Math.cos(a) * 0.1, 0.08 + (i % 2) * 0.03, Math.sin(a) * 0.1);
      item.add(f);
    }
    const top = mesh(new THREE.SphereGeometry(0.11, 10, 8), m.broccoli, false);
    top.position.y = 0.14;
    item.add(top);
  } else if (kind === 2) {
    const slice = mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.07, 24), [m.courgette, m.courgetteIn, m.courgetteIn], false);
    slice.rotation.x = Math.PI / 2;
    item.add(slice);
  } else {
    for (let i = 0; i < 6; i++) {
      const seg = mesh(new THREE.SphereGeometry(0.075 - Math.abs(i - 2.5) * 0.006, 10, 8), m.worm, false);
      seg.position.set((i - 2.5) * 0.08, Math.sin(i * 0.9) * 0.03, 0);
      item.add(seg);
    }
  }
  item.position.y = 0.55;
  g.add(item);
  const glow = new THREE.Sprite(m.glow);
  glow.scale.set(0.9, 0.9, 1);
  glow.position.y = 0.55;
  g.add(glow);
  g.userData.float = item;
  return g;
}

/** A small saucer-style running wheel: ride it. */
export function buildMiniWheel(scale = 1) {
  const m = mats();
  const g = new THREE.Group();
  const spin = new THREE.Group();
  spin.add(mesh(new THREE.TorusGeometry(0.62, 0.07, 10, 40), m.teal));
  for (let i = 0; i < 6; i++) {
    const sp = mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.2, 6), m.teal);
    sp.rotation.z = (i / 6) * Math.PI;
    spin.add(sp);
  }
  spin.position.y = 0.66;
  g.add(spin);
  g.scale.setScalar(scale);
  g.userData.spin = spin;
  return g;
}

export function buildBall(r = 0.6) {
  const m = mats();
  const g = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 20), m.clear);
  const band = mesh(new THREE.TorusGeometry(r, 0.035, 8, 40), m.teal, false);
  band.rotation.y = Math.PI / 2;
  g.add(shell, band);
  return g;
}

function buildDrop() {
  const g = new THREE.Group();
  const cube = mesh(new THREE.BoxGeometry(0.62, 0.62, 0.62), mats().block);
  cube.position.y = 0.75;
  g.add(cube);
  cube.add(new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry), new THREE.LineBasicMaterial({ color: '#e9fbff' })));
  g.userData.float = cube;
  return g;
}

export function buildObstacle(o: Obs): THREE.Object3D {
  switch (o.kind) {
    case 'block':
      return buildHideout();
    case 'low':
      return buildLog();
    case 'high':
      return buildBridge();
    case 'car':
      return buildRoller();
    case 'worm':
      return buildSnack(o.id);
    case 'wheel': {
      const w = buildMiniWheel(0.75);
      w.userData.float = w.userData.spin;
      return w;
    }
    case 'ball': {
      const g = new THREE.Group();
      const b = buildBall(0.42);
      b.position.y = 0.6;
      g.add(b);
      g.userData.float = b;
      return g;
    }
    case 'bdrop':
      return buildDrop();
  }
}

// ---------- The giant wheel and the cage around it ----------

function buildWheel(mirrored: boolean) {
  const g = new THREE.Group();
  const spin = new THREE.Group();
  g.add(spin);
  const tread = treadTex().clone();
  tread.needsUpdate = true;
  tread.repeat.set(Math.round((2 * Math.PI * R) / 2.2), 1);
  const treadGeo = new THREE.CylinderGeometry(R, R, DEPTH, 160, 1, true);
  treadGeo.rotateX(Math.PI / 2);
  const inner = new THREE.Mesh(treadGeo, new THREE.MeshStandardMaterial({ map: tread, roughness: 0.55, side: THREE.BackSide }));
  inner.receiveShadow = true;
  spin.add(inner);
  const outerGeo = new THREE.CylinderGeometry(R + 0.2, R + 0.2, DEPTH, 160, 1, true);
  outerGeo.rotateX(Math.PI / 2);
  spin.add(new THREE.Mesh(outerGeo, new THREE.MeshStandardMaterial({ color: '#7f9ab3', roughness: 0.4 })));
  const lipMat = new THREE.MeshStandardMaterial({ color: '#5b7795', roughness: 0.35 });
  for (const z of [DEPTH / 2, -DEPTH / 2]) {
    const lip = new THREE.Mesh(new THREE.TorusGeometry(R + 0.1, 0.16, 12, 160), lipMat);
    lip.position.z = z;
    spin.add(lip);
  }
  // The mirrored half still reads WHEELY9000 the right way round.
  const dtex = mirrored ? discTex().clone() : discTex();
  if (mirrored) {
    dtex.wrapS = THREE.RepeatWrapping;
    dtex.repeat.x = -1;
    dtex.needsUpdate = true;
  }
  const disc = new THREE.Mesh(new THREE.CircleGeometry(R + 0.2, 128), new THREE.MeshStandardMaterial({ map: dtex, roughness: 0.5 }));
  disc.position.z = -DEPTH / 2 - 0.01;
  disc.receiveShadow = true;
  spin.add(disc);
  // The magnet the WHEELY9000 counts, on the front lip.
  const magnet = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.26, 0.2), new THREE.MeshStandardMaterial({ color: '#f4f4f4', roughness: 0.3 }));
  magnet.position.set(0, -(R + 0.3), DEPTH / 2 + 0.05);
  spin.add(magnet);

  // Stand and axle behind the disc.
  const steel = new THREE.MeshStandardMaterial({ color: '#8d99a6', roughness: 0.3, metalness: 0.6 });
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.4, 20), steel);
  axle.rotation.x = Math.PI / 2;
  axle.position.z = -DEPTH / 2 - 0.7;
  g.add(axle);
  for (const s of [-1, 1]) {
    const len = Math.hypot(R * 0.75, -FLOOR_Y);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, len, 14), steel);
    leg.position.set((R * 0.75 * s) / 2, FLOOR_Y / 2, -DEPTH / 2 - 1.2);
    leg.rotation.z = Math.atan2(R * 0.75, -FLOOR_Y) * s;
    g.add(leg);
  }
  // The sensor box, low on the front lip, with its LED.
  const sensor = new THREE.Group();
  sensor.add(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.45), new THREE.MeshStandardMaterial({ color: '#2b2f3a', roughness: 0.5 })));
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), new THREE.MeshStandardMaterial({ color: '#1b3a22', emissive: '#39ff7a', emissiveIntensity: 0 }));
  led.position.set(0.25, 0.1, 0.24);
  sensor.add(led);
  const sensorA = -0.42;
  sensor.position.set(Math.sin(sensorA) * (R + 0.75), -Math.cos(sensorA) * (R + 0.75), DEPTH / 2 + 0.25);
  sensor.rotation.z = sensorA;
  g.add(sensor);
  return { group: g, spin, led: led.material as THREE.MeshStandardMaterial, sensorA };
}

function buildCage(scene: THREE.Object3D) {
  const bedTex = beddingTex().clone();
  bedTex.needsUpdate = true;
  bedTex.repeat.set(10, 10);
  const bedMat = new THREE.MeshStandardMaterial({ map: bedTex, roughness: 1 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), bedMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.receiveShadow = true;
  scene.add(floor);
  const rnd = (i: number) => {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  // Soft mounds of bedding and scattered bits.
  for (let i = 0; i < 26; i++) {
    const a = rnd(i) * Math.PI * 2;
    const d = R + 1.5 + rnd(i + 50) * 14;
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), bedMat);
    m.scale.set(1.2 + rnd(i + 9) * 2.5, 0.35 + rnd(i + 3) * 0.6, 1 + rnd(i + 7) * 2);
    m.position.set(Math.cos(a) * d, FLOOR_Y, Math.sin(a) * d * 0.7 + 1);
    m.receiveShadow = true;
    scene.add(m);
  }
  const bits = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.35, 0.12), new THREE.MeshStandardMaterial({ color: '#fbf6ec', side: THREE.DoubleSide }), 500);
  const tmp = new THREE.Object3D();
  for (let i = 0; i < 500; i++) {
    tmp.position.set((rnd(i * 3) - 0.5) * 50, FLOOR_Y + 0.03 + rnd(i * 5) * 0.08, (rnd(i * 7) - 0.3) * 30);
    tmp.rotation.set(-Math.PI / 2 + (rnd(i) - 0.5) * 0.6, 0, rnd(i * 11) * Math.PI);
    tmp.updateMatrix();
    bits.setMatrixAt(i, tmp.matrix);
  }
  scene.add(bits);
  // A cork hide, a water bowl and a sand bath on the floor around the wheel.
  const m = mats();
  const hideGeo = new THREE.CylinderGeometry(2, 2, 3.6, 28, 1, true, 0, Math.PI);
  hideGeo.rotateX(Math.PI / 2);
  const hide = mesh(hideGeo, new THREE.MeshStandardMaterial({ map: corkTex(), roughness: 0.95, side: THREE.DoubleSide }));
  hide.position.set(R + 4.5, FLOOR_Y, 2);
  hide.rotation.y = 0.5;
  scene.add(hide);
  void m;
  const bowl = mesh(new THREE.CylinderGeometry(1.3, 1.0, 0.7, 32), new THREE.MeshStandardMaterial({ color: '#e9eef2', roughness: 0.2 }));
  bowl.position.set(-R - 3, FLOOR_Y + 0.35, 4);
  scene.add(bowl);
  const water = new THREE.Mesh(new THREE.CircleGeometry(1.15, 32), new THREE.MeshStandardMaterial({ color: '#8fc8e8', roughness: 0.05, metalness: 0.2 }));
  water.rotation.x = -Math.PI / 2;
  water.position.set(-R - 3, FLOOR_Y + 0.62, 4);
  scene.add(water);
  const bath = mesh(new THREE.CylinderGeometry(2.2, 2, 0.6, 36), new THREE.MeshStandardMaterial({ color: '#d7c6ef', roughness: 0.4 }));
  bath.position.set(R + 2, FLOOR_Y + 0.3, 7.5);
  scene.add(bath);
  const sand = new THREE.Mesh(new THREE.CircleGeometry(2.0, 36), new THREE.MeshStandardMaterial({ color: '#e8d6a8', roughness: 1 }));
  sand.rotation.x = -Math.PI / 2;
  sand.position.set(R + 2, FLOOR_Y + 0.62, 7.5);
  scene.add(sand);
  // The back of the glass tank.
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(90, 40), new THREE.MeshStandardMaterial({ color: '#cfe3ea', roughness: 0.1, metalness: 0.1 }));
  glass.position.set(0, FLOOR_Y + 20, -9);
  scene.add(glass);
}

// ---------- Soft particles ----------

export class Puffs {
  private items: { s: THREE.Sprite; v: THREE.Vector3; life: number; max: number; size: number }[] = [];
  constructor(parent: THREE.Object3D, count: number) {
    for (let i = 0; i < count; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot(), transparent: true, depthWrite: false, opacity: 0 }));
      s.visible = false;
      parent.add(s);
      this.items.push({ s, v: new THREE.Vector3(), life: 0, max: 1, size: 0.2 });
    }
  }
  emit(at: THREE.Vector3, n: number, spread: number, up: number, life: number, color: string, size = 0.25, back = 0) {
    for (const p of this.items) {
      if (n <= 0) break;
      if (p.life > 0) continue;
      p.s.position.set(at.x + (Math.random() - 0.5) * spread, at.y + Math.random() * 0.2, at.z + (Math.random() - 0.5) * spread);
      p.v.set((Math.random() - 0.5) * spread * 2 - back, up * (0.5 + Math.random()), (Math.random() - 0.5) * spread * 2);
      p.life = p.max = life * (0.7 + Math.random() * 0.6);
      p.size = size * (0.6 + Math.random() * 0.8);
      p.s.material.color.set(color);
      p.s.visible = true;
      n--;
    }
  }
  tick(dt: number) {
    for (const p of this.items) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.s.position.addScaledVector(p.v, dt);
      p.v.y -= dt * 5;
      const k = p.life / p.max;
      p.s.material.opacity = Math.min(1, k * 1.5) * 0.9;
      p.s.scale.setScalar(p.size * (1.6 - k * 0.6));
      if (p.life <= 0) p.s.visible = false;
    }
  }
}

// ---------- The camera look: day colour or infrared night camera ----------

export const POST_VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
export const POST_FRAG = `
uniform sampler2D tScene; uniform float uNight; uniform float uFlash; uniform float uTime; uniform vec2 uRes;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec2 c = vUv - 0.5;
  // The night camera's cheap lens bulges a little.
  vec2 uv = mix(vUv, 0.5 + c * (1.0 - 0.06 * dot(c, c)), uNight);
  vec3 col = texture2D(tScene, uv).rgb;
  vec3 day = pow(aces(col * 1.05), vec3(1.0 / 2.2));
  day *= mix(vec3(1.0), vec3(1.04, 1.0, 0.95), 0.6);
  float l = dot(pow(aces(col * 1.25), vec3(1.0 / 2.2)), vec3(0.3, 0.59, 0.11));
  vec3 ir = vec3(pow(l, 1.25)) * vec3(0.84, 1.0, 0.9);
  ir += (hash(floor(vUv * uRes) + fract(uTime * 7.0)) - 0.5) * 0.1;
  ir *= 0.95 + 0.05 * sin(vUv.y * uRes.y * 1.4);
  float vig = smoothstep(0.85, 0.25, length(c * vec2(1.0, 0.9)));
  vec3 outc = mix(day * mix(1.0, vig, 0.3), ir * mix(0.4, 1.0, vig), uNight);
  outc = mix(outc, 1.0 - outc, uFlash);
  gl_FragColor = vec4(outc, 1.0);
}`;

export interface SideView {
  /** Live Squeektoshi facts for the in-game LED board (wide version). */
  ticker?: string;
  state: PState;
  course: readonly Obs[];
  /** Squeektoshi is running right now (live). */
  live: boolean;
  /** The other player's run, drawn see-through in this wheel. */
  ghost?: PState | null;
  ghostName?: string;
}

class SideWorld {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.3, 200);
  /** 0 = day, 1 = night camera. */
  nightMix = 0;
  flash = 0;
  private root = new THREE.Group();
  private wheel: ReturnType<typeof buildWheel>;
  private runner = new Hamster();
  private ghost = new Hamster(true);
  private ghostTag: THREE.Sprite;
  private ghostTagName = '';
  private rideWheel = buildMiniWheel(1.05);
  private rideBall = buildBall(0.95);
  private shadowBlob: THREE.Mesh;
  private obs = new Map<number, THREE.Object3D>();
  private puffs: Puffs;
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private ir: THREE.PointLight;
  /** At night the IR lamp is aimed at the runner, so the hamster glows like on the real stream. */
  private lamp: THREE.PointLight;
  private bgDay = new THREE.Color('#f1e4d0');
  private bgNight = new THREE.Color('#0b0f0d');
  private lastT = 0;
  private shake = 0;
  private bump = 0;
  private rest = 0;
  private coast = 0;
  private coastV = 0;
  private wasTired = false;
  private seen = { stumbles: 0, breaks: 0, worms: 0, rides: 0, blocks: 0, tick: -1 };
  private stepAcc = 0;
  private camZ = 0;
  private target = new THREE.Vector3();

  constructor(private mirrored: boolean) {
    if (mirrored) this.root.scale.x = -1;
    this.wheel = buildWheel(mirrored);
    this.scene.add(this.root);
    this.scene.background = this.bgDay.clone();
    this.scene.fog = new THREE.Fog(this.bgDay.getHex(), 30, 70);

    this.hemi = new THREE.HemisphereLight('#fff3df', '#8a7a68', 1.4);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff1d8', 2.2);
    this.sun.position.set(mirrored ? -4 : 4, 6, 12);
    this.sun.target.position.set(0, -R, 0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.left = -9;
    sc.right = 9;
    sc.top = 9;
    sc.bottom = -9;
    sc.near = 1;
    sc.far = 40;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);
    // The infrared lamp sits by the night camera.
    this.ir = new THREE.PointLight('#ffffff', 0, 40, 1.2);
    this.scene.add(this.ir);
    this.lamp = new THREE.PointLight('#ffffff', 0, 9, 1.4);
    this.root.add(this.lamp);

    this.root.add(this.wheel.group);
    buildCage(this.root);
    // A touch bigger than life so the animation reads from the camera.
    this.runner.group.scale.setScalar(1.3);
    this.ghost.group.scale.setScalar(1.3);
    this.root.add(this.runner.group);
    this.ghost.group.visible = false;
    this.root.add(this.ghost.group);
    this.ghostTag = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex('RIVAL'), transparent: true, depthWrite: false }));
    this.ghostTag.scale.set(1.6, 0.45, 1);
    this.ghostTag.visible = false;
    this.root.add(this.ghostTag);
    this.rideWheel.visible = false;
    this.rideBall.visible = false;
    this.root.add(this.rideWheel, this.rideBall);
    this.shadowBlob = new THREE.Mesh(new THREE.CircleGeometry(0.8, 24), new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.22, depthWrite: false }));
    this.shadowBlob.rotation.x = -Math.PI / 2;
    this.root.add(this.shadowBlob);
    this.puffs = new Puffs(this.root, 40);
  }

  resetCourse() {
    for (const o of this.obs.values()) this.root.remove(o);
    this.obs.clear();
    this.coast = 0;
    this.coastV = 0;
    this.rest = 0;
    this.wasTired = false;
  }

  frame(rect: { w: number; h: number }) {
    const aspect = rect.w / Math.max(1, rect.h);
    this.camera.aspect = aspect;
    // Portrait halves need a wider lens to keep the rim ahead in view.
    this.camera.fov = aspect < 0.75 ? 82 : aspect < 1.05 ? 72 : 64;
    const j = this.shake * 0.22;
    const sx = this.mirrored ? -1 : 1;
    // Behind the hamster and out past the open side of the wheel, looking down at about 45°:
    // the three lanes run ahead of you and the rim curls up into view.
    this.camera.position.set(sx * (-6.4 + (Math.random() - 0.5) * j), -R + 4.1 + (Math.random() - 0.5) * j, 7.4 + this.camZ * 0.4);
    this.target.set(sx * 3.8, -R + 4.1, this.camZ * 0.5 - 1.0);
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    this.ir.position.copy(this.camera.position);
  }

  update(v: SideView, time: number) {
    const s = v.state;
    const dt = Math.min(0.05, Math.max(0, time - this.lastT));
    this.lastT = time;
    const isTired = tired(s);

    // Day and night take turns, like the real stream; the switch flashes like a camera changing mode.
    const wantNight = Math.floor(s.dist / CYCLE_M) % 2 === 1 ? 1 : 0;
    const before = this.nightMix;
    this.nightMix += Math.sign(wantNight - this.nightMix) * Math.min(Math.abs(wantNight - this.nightMix), dt * 1.4);
    this.flash = before !== this.nightMix ? Math.sin(Math.PI * this.nightMix) * 0.9 : 0;
    const n = this.nightMix;
    (this.scene.background as THREE.Color).copy(this.bgDay).lerp(this.bgNight, n);
    (this.scene.fog as THREE.Fog).color.copy(this.scene.background as THREE.Color);
    this.hemi.intensity = 1.4 * (1 - n) + 0.12 * n;
    this.sun.intensity = 2.2 * (1 - n) + 0.15 * n;
    this.ir.intensity = 22 * n;
    this.lamp.intensity = 6 * n;

    // When the hamster stops, the wheel coasts on for a moment and slows down.
    if (isTired && !this.wasTired) this.coastV = Math.max(4, s.speed || 8);
    this.wasTired = isTired;
    if (isTired) {
      this.coastV = Math.max(0, this.coastV - dt * 7);
      this.coast += this.coastV * dt;
      this.rest = Math.min(1, this.rest + dt * 1.2);
    } else {
      this.coast = 0;
      this.rest = Math.max(0, this.rest - dt * 3);
    }
    const dist = s.dist + this.coast;

    // Turn the wheel. The sensor LED blinks each time the magnet passes it.
    const turn = -dist / R;
    this.wheel.spin.rotation.z = turn;
    const TAU = Math.PI * 2;
    const diff = Math.abs((((turn - this.wheel.sensorA) % TAU) + TAU) % TAU);
    const near = diff < 0.12 || diff > TAU - 0.12;
    this.wheel.led.emissiveIntensity = near ? 3 : Math.max(0, this.wheel.led.emissiveIntensity - dt * 6);

    // The runner.
    const z = laneZ(laneX(s));
    this.camZ += (z - this.camZ) * Math.min(1, dt * 5);
    const jump = s.air > 0 ? 1 - s.air / JUMP_TICKS : -1;
    const hop = jump >= 0 ? 4 * jump * (1 - jump) * 1.55 : 0;
    const sliding = s.slide > 0 && s.air === 0;
    this.runner.group.position.set(0, -R + hop + (s.ride === RIDE_BALL ? 0.35 : s.ride === RIDE_WHEEL ? 0.12 : 0), z);
    this.runner.update(
      { speed: isTired ? 0 : s.speed, jump, sliding, bump: this.bump, rest: this.rest, puffed: s.energy === 1 && !isTired, night: n },
      dt,
      time,
    );
    this.lamp.position.set(-1.4, -R + 2.6, z + 2.2);
    this.shadowBlob.position.set(0.05, -R + 0.03, z);
    this.shadowBlob.scale.setScalar(1 / (1 + hop * 0.6));
    (this.shadowBlob.material as THREE.MeshBasicMaterial).opacity = 0.22 * (1 - n * 0.5);

    // Rides.
    this.rideWheel.visible = s.ride === RIDE_WHEEL;
    this.rideBall.visible = s.ride === RIDE_BALL;
    if (this.rideWheel.visible) {
      this.rideWheel.position.set(0, -R + hop - 0.04, z);
      (this.rideWheel.userData.spin as THREE.Object3D).rotation.z = -dist * 1.6;
    }
    if (this.rideBall.visible) {
      this.rideBall.position.set(0, -R + hop + 1.1, z);
      this.rideBall.rotation.z = -dist / 1.1;
    }

    // Feedback for bumps, snacks, rides.
    const seen = this.seen;
    const feet = new THREE.Vector3(0, -R + 0.1, z);
    if (s.tick < seen.tick) Object.assign(seen, { stumbles: 0, breaks: 0, worms: 0, rides: 0, blocks: 0 });
    if (s.stumbles > seen.stumbles) {
      this.shake = 1;
      this.bump = 1;
      this.puffs.emit(feet.clone().setY(-R + 0.5), 12, 0.6, 2.4, 0.6, n > 0.5 ? '#ffffff' : '#f6eddc', 0.35);
    }
    if (s.breaks > seen.breaks) {
      this.shake = 1;
      this.puffs.emit(feet.clone().setY(-R + 0.9), 18, 0.9, 3, 0.8, '#7fe6ff', 0.25);
    }
    if (s.worms > seen.worms) this.puffs.emit(feet.clone().setY(-R + 0.7), 7, 0.4, 2.2, 0.5, '#ffe28a', 0.18);
    if (s.rides > seen.rides || s.blocks > seen.blocks) this.puffs.emit(feet.clone().setY(-R + 0.9), 22, 0.9, 3.4, 0.9, '#7fe6ff', 0.22);
    Object.assign(seen, { stumbles: s.stumbles, breaks: s.breaks, worms: s.worms, rides: s.rides, blocks: s.blocks, tick: s.tick });
    // Little kicks of bedding dust from the feet while running.
    if (!isTired && jump < 0) {
      this.stepAcc += dt * s.speed * 0.6;
      if (this.stepAcc > 1) {
        this.stepAcc = 0;
        this.puffs.emit(feet.clone().add(new THREE.Vector3(-0.4, 0, 0)), sliding ? 4 : 1, 0.3, 0.8, 0.45, n > 0.5 ? '#cfd8cf' : '#efe2c8', sliding ? 0.3 : 0.18, s.speed * 0.4);
      }
    }
    this.puffs.tick(dt);
    this.shake = Math.max(0, this.shake - dt * 3);
    this.bump = Math.max(0, this.bump - dt * (60 / STUMBLE_TICKS));

    // Obstacles and treats ride round on the wheel.
    for (const o of v.course) {
      const front = o.kind === 'car' ? carD(o, s.dist) : o.d;
      const a = front - dist;
      let m = this.obs.get(o.id);
      if (a > AHEAD || a < -4) {
        if (m) m.visible = false;
        if (o.d - dist > AHEAD + 60) break;
        continue;
      }
      if (!m) {
        m = buildObstacle(o);
        this.obs.set(o.id, m);
        this.root.add(m);
      }
      const treat = o.kind === 'worm' || o.kind === 'wheel' || o.kind === 'ball' || o.kind === 'bdrop';
      m.visible = !(treat && a < 0.2 && Math.abs(laneX(s) - o.lane) < 0.45);
      onRim(m, a, laneZ(o.lane));
      m.scale.setScalar(Math.min(1, Math.max(0.01, (AHEAD - a) / GROW)));
      const fl = m.userData.float as THREE.Object3D | undefined;
      if (fl) {
        fl.rotation.y = time * 2 + o.id;
        fl.position.y = (o.kind === 'bdrop' ? 0.75 : o.kind === 'wheel' ? 0.66 : 0.55) + Math.sin(time * 3 + o.id) * 0.08;
      }
      const roll = m.userData.roll as THREE.Object3D | undefined;
      if (roll) roll.rotation.z = (o.d - front) / 0.72;
    }

    // The rival, see-through, in your wheel.
    const gs = v.ghost;
    const ga = gs ? gs.dist - s.dist : 0;
    const showGhost = !!gs && !tired(gs) && Math.abs(ga) > 1.6 && ga < AHEAD * 0.6 && ga > -R * 0.6;
    this.ghost.group.visible = showGhost;
    this.ghostTag.visible = showGhost;
    if (gs && showGhost) {
      onRim(this.ghost.group, ga, laneZ(laneX(gs)));
      this.ghost.update({ speed: gs.speed, jump: gs.air > 0 ? 1 - gs.air / JUMP_TICKS : -1, sliding: gs.slide > 0 && gs.air === 0, bump: 0, rest: 0, puffed: false, night: n }, dt, time);
      this.ghostTag.position.copy(this.ghost.group.position).add(new THREE.Vector3(-Math.sin(ga / R) * 1.9, Math.cos(ga / R) * 1.9, 0));
      if (v.ghostName && v.ghostName !== this.ghostTagName) {
        this.ghostTagName = v.ghostName;
        this.ghostTag.material.map?.dispose();
        this.ghostTag.material.map = labelTex(v.ghostName.slice(0, 10).toUpperCase());
        this.ghostTag.material.needsUpdate = true;
      }
    }
  }
}

export interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Two wheels side by side (stacked on a portrait phone), each through its own camera look. */
export class Arena {
  readonly renderer: THREE.WebGLRenderer;
  readonly left = new SideWorld(false);
  readonly right = new SideWorld(true);
  private size = { w: 1, h: 1 };
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private post: THREE.ShaderMaterial;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  stacked = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.setScissorTest(true);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const rt = () => new THREE.WebGLRenderTarget(2, 2, { samples: 4, type: THREE.HalfFloatType });
    this.targets = [rt(), rt()];
    this.post = new THREE.ShaderMaterial({
      vertexShader: POST_VERT,
      fragmentShader: POST_FRAG,
      uniforms: {
        tScene: { value: null },
        uNight: { value: 1 },
        uFlash: { value: 0 },
        uTime: { value: 0 },
        uRes: { value: new THREE.Vector2(1, 1) },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.post));
  }

  resize() {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(2, el.clientWidth);
    const h = Math.max(2, el.clientHeight);
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.stacked = w / h < 0.85;
  }

  /** CSS-pixel rectangles of each half, for placing the HUD. */
  halves(): [Viewport, Viewport] {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (this.stacked) {
      // Phone portrait: rival on top, you at the bottom, close to your thumbs.
      return [
        { x: 0, y: h / 2, w, h: h / 2 },
        { x: 0, y: 0, w, h: h / 2 },
      ];
    }
    return [
      { x: 0, y: 0, w: w / 2, h },
      { x: w / 2, y: 0, w: w / 2, h },
    ];
  }

  /** How much of each side is on the night camera right now (for the on-screen camera labels). */
  nights(): [number, number] {
    return [this.left.nightMix, this.right.nightMix];
  }

  render(me: SideView, opp: SideView, time: number) {
    const { w, h } = this.size;
    const pr = this.renderer.getPixelRatio();
    this.left.update(me, time);
    this.right.update(opp, time);
    const draw = (world: SideWorld, rt: THREE.WebGLRenderTarget, x: number, y: number, vw: number, vh: number) => {
      world.frame({ w: vw, h: vh });
      const pw = Math.max(2, Math.floor(vw * pr));
      const ph = Math.max(2, Math.floor(vh * pr));
      if (rt.width !== pw || rt.height !== ph) rt.setSize(pw, ph);
      this.renderer.setRenderTarget(rt);
      this.renderer.render(world.scene, world.camera);
      this.renderer.setRenderTarget(null);
      this.renderer.setViewport(x, y, vw, vh);
      this.renderer.setScissor(x, y, vw, vh);
      const u = this.post.uniforms;
      u.tScene.value = rt.texture;
      u.uNight.value = world.nightMix;
      u.uFlash.value = world.flash;
      u.uTime.value = time;
      u.uRes.value.set(pw, ph);
      this.renderer.render(this.postScene, this.postCam);
    };
    if (this.stacked) {
      const half = Math.floor(h / 2);
      draw(this.left, this.targets[0], 0, 0, w, half); // bottom (WebGL y goes up)
      draw(this.right, this.targets[1], 0, half, w, h - half);
    } else {
      const half = Math.floor(w / 2);
      draw(this.left, this.targets[0], 0, 0, half, h);
      draw(this.right, this.targets[1], half, 0, w - half, h);
    }
  }

  resetCourse() {
    this.left.resetCourse();
    this.right.resetCourse();
  }
}

const BOLT_SVG =
  '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true"><path fill="#ffd84d" stroke="#b8860b" stroke-width="0.8" d="M13.5 1.5 3.5 13.6h6.9l-1.6 8.9 10.7-12.6h-7z"/></svg>';

/**
 * Small pictures of the real 3D models for the page (cards, badges), rendered once off-screen,
 * so the site and the game look the same.
 */
export function renderIcons(root: ParentNode = document) {
  const els = [...root.querySelectorAll<HTMLElement>('[data-icon]')];
  if (!els.length) return;
  const S = 192;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return;
  }
  renderer.setSize(S, S, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#fff6e8', '#b9a58c', 2.2));
  const key = new THREE.DirectionalLight('#ffffff', 2.4);
  key.position.set(-3, 5, 6);
  scene.add(key);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  const cache = new Map<string, string>();
  const shot = (name: string): string | null => {
    if (cache.has(name)) return cache.get(name)!;
    let obj: THREE.Object3D;
    if (name === 'hamster') {
      const h = new Hamster();
      h.update({ speed: 0, jump: -1, sliding: false, bump: 0, rest: 0, puffed: false, night: 0 }, 0, 0.3);
      obj = h.group;
    } else if (['block', 'low', 'high', 'car', 'worm', 'wheel', 'ball', 'bdrop'].includes(name)) {
      obj = buildObstacle({ id: 1, d: 0, kind: name as Obs['kind'], lane: 1, len: 1 });
    } else return null;
    scene.add(obj);
    // Frame the model itself, not the glow around a snack.
    const box = new THREE.Box3().setFromObject(name === 'worm' ? (obj.userData.float as THREE.Object3D) : obj);
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    const d = r / Math.sin(THREE.MathUtils.degToRad(15)) * 1.02;
    cam.position.copy(c).add(new THREE.Vector3(-0.75, 0.45, 0.85).normalize().multiplyScalar(d));
    cam.lookAt(c);
    renderer.render(scene, cam);
    scene.remove(obj);
    const url = renderer.domElement.toDataURL('image/png');
    cache.set(name, url);
    return url;
  };
  for (const el of els) {
    const name = el.dataset.icon!;
    const size = Number(el.dataset.size) || 72;
    el.style.display = 'inline-block';
    el.style.width = el.style.height = `${size}px`;
    if (name === 'energy') {
      el.innerHTML = BOLT_SVG + BOLT_SVG + BOLT_SVG;
      el.style.display = 'inline-flex';
      el.style.width = `${size * 1.6}px`;
      continue;
    }
    const url = shot(name);
    if (!url) continue;
    const img = new Image(size, size);
    img.src = url;
    img.alt = '';
    img.decoding = 'async';
    el.replaceChildren(img);
  }
  renderer.dispose();
  renderer.forceContextLoss();
}
