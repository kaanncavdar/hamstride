import * as THREE from 'three';
import type { Obs } from '../shared/course';
import { FINISH_M } from '../shared/constants';
import { AIR_TICKS, CAT_TELE, catWatching, laneT, STUN_CRASH, STUN_HEAT, STUN_SCARED, type PState } from '../shared/sim';

/** Pixel size of the render: the 3D scene is drawn small and scaled up with nearest-neighbour. */
const PIXEL = 3;
const R = 1.0; // wheel radius
const LANE_X = [-0.85, 0.85];
const PLANK = 1.2;
const PLANKS = 46;
const DECOR_SPAN = 90;

const C = {
  dayBg: 0x9fd8cb, nightBg: 0x1d1a3a,
  dayFloor: 0xe9d3a8, nightFloor: 0x4a3f6b,
  plankA: 0xc98b4f, plankB: 0xb7794a, nightPlankA: 0x7a5442, nightPlankB: 0x6b4a3a,
  wheel: 0x4ee6ff, wheelHot: 0xff4d5a, rung: 0xd8f6ff,
  fur: 0xe8a25a, belly: 0xfff1d6, pink: 0xf4a6b5, ink: 0x1b1530,
  pencil: 0xffd23f, wood: 0xe7c08a, eraser: 0xf48ca0, roll: 0xf8f4ea, seed: 0xffcf4a, chili: 0xff3b3b,
  leaf: 0x3fbf6a, cat: 0x3b3646, catEye: 0xffe14d, block: 0x4ee6ff, bottle: 0x9ad7ff, tube: 0xff8fb1,
};

const mat = (color: number, extra: THREE.MeshLambertMaterialParameters = {}) =>
  new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });

function box(w: number, h: number, d: number, color: number) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
}

function buildHamster(): { group: THREE.Group; feet: THREE.Mesh[]; body: THREE.Mesh } {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 1), mat(C.fur));
  body.scale.set(1, 0.85, 1.2);
  g.add(body);
  const belly = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1), mat(C.belly));
  belly.position.set(0, -0.08, -0.18);
  belly.scale.set(1, 0.8, 1.1);
  g.add(belly);
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 1), mat(C.fur));
  head.position.set(0, 0.12, -0.45);
  g.add(head);
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), mat(C.pink));
    ear.position.set(0.16 * sx, 0.38, -0.4);
    g.add(ear);
    const eye = box(0.07, 0.09, 0.04, C.ink);
    eye.position.set(0.13 * sx, 0.18, -0.72);
    g.add(eye);
    const cheek = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 0), mat(C.belly));
    cheek.position.set(0.2 * sx, 0.02, -0.6);
    g.add(cheek);
  }
  const nose = box(0.07, 0.05, 0.05, C.pink);
  nose.position.set(0, 0.08, -0.76);
  g.add(nose);
  const feet: THREE.Mesh[] = [];
  for (const [x, z] of [[-0.18, -0.25], [0.18, -0.25], [-0.2, 0.25], [0.2, 0.25]]) {
    const f = box(0.12, 0.08, 0.16, C.pink);
    f.position.set(x, -0.36, z);
    g.add(f);
    feet.push(f);
  }
  const tail = box(0.08, 0.08, 0.08, C.pink);
  tail.position.set(0, 0.0, 0.5);
  g.add(tail);
  return { group: g, feet, body };
}

function buildWheel() {
  const group = new THREE.Group();
  const spin = new THREE.Group();
  const rimMat = mat(C.wheel, { emissive: 0x0a3a44 });
  for (const x of [-0.52, 0.52]) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.06, 4, 20), rimMat);
    rim.rotation.y = Math.PI / 2;
    rim.position.x = x;
    spin.add(rim);
    for (let i = 0; i < 3; i++) {
      const spoke = box(0.04, R * 2, 0.06, C.rung);
      spoke.position.x = x;
      spoke.rotation.x = (i * Math.PI) / 3;
      spin.add(spoke);
    }
  }
  const rungMat = mat(C.rung);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.04, 4), rungMat);
    rung.rotation.z = Math.PI / 2;
    rung.position.set(0, Math.cos(a) * (R - 0.02), Math.sin(a) * (R - 0.02));
    spin.add(rung);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.2, 6), mat(C.ink));
  hub.rotation.z = Math.PI / 2;
  spin.add(hub);
  group.add(spin);
  const ham = buildHamster();
  ham.group.position.set(0, -R + 0.45, 0);
  group.add(ham.group);
  return { group, spin, rimMat, ham };
}

function textSprite(text: string, fg = '#1b1530', bg = '#fff6e0') {
  const cv = document.createElement('canvas');
  cv.width = 48;
  cv.height = 20;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 48, 20);
  ctx.fillStyle = fg;
  ctx.fillRect(0, 18, 48, 2);
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 24, 10);
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
  sp.scale.set(1.6, 0.66, 1);
  return sp;
}

/** Deterministic pseudo-random for decor placement. */
function hash01(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function buildObstacle(o: Obs): THREE.Object3D {
  const g = new THREE.Group();
  switch (o.kind) {
    case 'hurdle': {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 3.2, 6), mat(C.pencil));
      body.rotation.z = Math.PI / 2;
      g.add(body);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.45, 6), mat(C.wood));
      tip.rotation.z = -Math.PI / 2;
      tip.position.x = 1.82;
      g.add(tip);
      const lead = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 6), mat(C.ink));
      lead.rotation.z = -Math.PI / 2;
      lead.position.x = 2.08;
      g.add(lead);
      const eraser = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.3, 6), mat(C.eraser));
      eraser.rotation.z = Math.PI / 2;
      eraser.position.x = -1.75;
      g.add(eraser);
      g.position.y = 0.16;
      break;
    }
    case 'block': {
      const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.58, 1.6, 10), mat(C.roll));
      roll.position.y = 0.8;
      g.add(roll);
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.02, 8), mat(0x8a6a4a));
      hole.position.y = 1.61;
      g.add(hole);
      g.position.x = LANE_X[o.lane];
      break;
    }
    case 'seed': {
      const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 0), mat(C.seed, { emissive: 0x6a4500 }));
      s.scale.set(0.8, 0.55, 1.4);
      g.add(s);
      g.position.set(LANE_X[o.lane], 0.32, 0);
      g.userData.spin = true;
      break;
    }
    case 'chili': {
      const c = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.75, 6), mat(C.chili, { emissive: 0x400000 }));
      c.rotation.x = Math.PI / 2;
      g.add(c);
      const stem = box(0.08, 0.08, 0.2, C.leaf);
      stem.position.z = -0.45;
      g.add(stem);
      g.position.set(LANE_X[o.lane], 0.22, 0);
      g.userData.spin = true;
      break;
    }
    case 'bdrop': {
      const cube = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), mat(C.block, { emissive: 0x0b6f84, transparent: true, opacity: 0.85 }));
      g.add(cube);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry), new THREE.LineBasicMaterial({ color: 0xffffff }));
      g.add(edges);
      g.position.y = 1.0;
      g.userData.spin = true;
      break;
    }
    case 'cat':
      break;
  }
  return g;
}

function buildCat() {
  const g = new THREE.Group();
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5, 1), mat(C.cat));
  head.scale.set(1.15, 0.95, 0.9);
  g.add(head);
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.9, 4), mat(C.cat));
    ear.position.set(0.95 * sx, 1.35, 0);
    ear.rotation.z = -0.35 * sx;
    g.add(ear);
  }
  const eyes: THREE.Mesh[] = [];
  const lids: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) {
    const eye = box(0.55, 0.42, 0.1, C.catEye);
    eye.position.set(0.6 * sx, 0.25, 1.32);
    const pupil = box(0.1, 0.36, 0.05, C.ink);
    pupil.position.z = 0.06;
    eye.add(pupil);
    g.add(eye);
    eyes.push(eye);
    const lid = box(0.6, 0.08, 0.1, C.ink);
    lid.position.set(0.6 * sx, 0.2, 1.33);
    g.add(lid);
    lids.push(lid);
  }
  const nose = box(0.22, 0.14, 0.1, C.pink);
  nose.position.set(0, -0.15, 1.38);
  g.add(nose);
  g.rotation.y = -0.9;
  return { group: g, eyes, lids };
}

export interface SideView {
  state: PState;
  course: readonly Obs[];
  night: boolean;
}

class SideWorld {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 1, 0.5, 220);
  private root = new THREE.Group();
  private wheel = buildWheel();
  private shadow: THREE.Mesh;
  private planks: THREE.Mesh[] = [];
  private plankMats: THREE.MeshLambertMaterial[];
  private floorMat = mat(C.dayFloor);
  private decor: THREE.Object3D[] = [];
  private obs = new Map<number, THREE.Object3D>();
  private cat = buildCat();
  private signs: THREE.Sprite[] = [];
  private finish: THREE.Group;
  private stars: THREE.Points;
  private night = false;

  constructor(private mirrored: boolean) {
    if (mirrored) this.root.scale.x = -1;
    this.scene.add(this.root);
    this.scene.background = new THREE.Color(C.dayBg);
    this.scene.fog = new THREE.Fog(C.dayBg, 34, 62);

    const hemi = new THREE.HemisphereLight(0xfff4e0, 0x6b5a8a, 1.6);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(mirrored ? 6 : -6, 10, 4);
    this.scene.add(sun);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 140), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -0.02, -40);
    this.root.add(floor);

    this.plankMats = [mat(C.plankA), mat(C.plankB)];
    const plankGeo = new THREE.BoxGeometry(3.6, 0.12, PLANK - 0.1);
    for (let i = 0; i < PLANKS; i++) {
      const m = new THREE.Mesh(plankGeo, this.plankMats[i % 2]);
      m.position.y = 0.0;
      this.root.add(m);
      this.planks.push(m);
    }
    for (const x of [-1.9, 1.9]) {
      const rail = box(0.16, 0.26, 140, 0x8f5d36);
      rail.position.set(x, 0.1, -40);
      this.root.add(rail);
    }
    // Centre line between the lanes.
    const line = box(0.06, 0.13, 140, 0xfff1d6);
    line.position.set(0, 0.01, -40);
    this.root.add(line);

    this.buildDecor();

    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(0.85, 8), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.08;
    this.root.add(this.shadow);
    this.root.add(this.wheel.group);

    this.cat.group.visible = false;
    this.root.add(this.cat.group);

    for (let i = 0; i < 3; i++) {
      const s = textSprite('0M');
      this.root.add(s);
      this.signs.push(s);
    }

    this.finish = new THREE.Group();
    for (const x of [-2.1, 2.1]) {
      const post = box(0.25, 3.2, 0.25, 0xfff6e0);
      post.position.set(x, 1.6, 0);
      this.finish.add(post);
    }
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 2; j++) {
        const c = box(0.44, 0.3, 0.1, (i + j) % 2 ? 0x1b1530 : 0xfff6e0);
        c.position.set(-1.98 + i * 0.44, 2.9 + j * 0.3, 0);
        this.finish.add(c);
      }
    }
    const flag = textSprite('FINISH', '#fff6e0', '#ff4d5a');
    flag.position.set(0, 3.8, 0);
    this.finish.add(flag);
    this.root.add(this.finish);

    const starGeo = new THREE.BufferGeometry();
    const pts: number[] = [];
    for (let i = 0; i < 160; i++) pts.push((hash01(i) - 0.5) * 70, 6 + hash01(i + 99) * 14, -10 - hash01(i + 7) * 60);
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xfff6e0, size: 2, sizeAttenuation: false }));
    this.stars.visible = false;
    this.root.add(this.stars);
  }

  private buildDecor() {
    for (let i = 0; i < 26; i++) {
      const side = i % 2 ? 1 : -1;
      const kind = Math.floor(hash01(i * 3) * 4);
      let o: THREE.Object3D;
      if (kind === 0) {
        const g = new THREE.Group();
        const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.6, 6), mat(C.bottle, { transparent: true, opacity: 0.8 }));
        bottle.position.y = 1.6;
        g.add(bottle);
        const tip = box(0.12, 0.6, 0.12, 0xb8c0cc);
        tip.position.y = 0.55;
        g.add(tip);
        const stand = box(0.1, 2.6, 0.1, 0x8b8698);
        stand.position.set(0.4, 1.3, 0);
        g.add(stand);
        o = g;
      } else if (kind === 1) {
        const tube = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.35, 5, 10, Math.PI), mat(C.tube, { transparent: true, opacity: 0.85 }));
        o = tube;
      } else if (kind === 2) {
        const g = new THREE.Group();
        const house = box(1.4, 0.9, 1.2, 0xffe0a8);
        house.position.y = 0.45;
        g.add(house);
        const roof = new THREE.Mesh(new THREE.ConeGeometry(1.1, 0.7, 4), mat(0xff8f6b));
        roof.position.y = 1.25;
        roof.rotation.y = Math.PI / 4;
        g.add(roof);
        const door = box(0.4, 0.5, 0.05, C.ink);
        door.position.set(0, 0.25, 0.61);
        g.add(door);
        o = g;
      } else {
        const g = new THREE.Group();
        for (let j = 0; j < 5; j++) {
          const chip = box(0.4, 0.12, 0.25, j % 2 ? 0xd9b47a : 0xc49a62);
          chip.position.set(hash01(i * 7 + j) * 1.2 - 0.6, 0.06, hash01(i * 11 + j) * 1.2 - 0.6);
          chip.rotation.y = hash01(i + j) * 3;
          g.add(chip);
        }
        o = g;
      }
      o.userData.x = side * (3 + hash01(i * 5) * 4);
      o.userData.z0 = (i / 26) * DECOR_SPAN;
      o.userData.rot = hash01(i * 13) * Math.PI;
      this.root.add(o);
      this.decor.push(o);
    }
  }

  setNight(night: boolean) {
    if (night === this.night) return;
    this.night = night;
    const bg = night ? C.nightBg : C.dayBg;
    (this.scene.background as THREE.Color).setHex(bg);
    (this.scene.fog as THREE.Fog).color.setHex(bg);
    this.floorMat.color.setHex(night ? C.nightFloor : C.dayFloor);
    this.plankMats[0].color.setHex(night ? C.nightPlankA : C.plankA);
    this.plankMats[1].color.setHex(night ? C.nightPlankB : C.plankB);
    this.stars.visible = night;
  }

  resetCourse() {
    for (const o of this.obs.values()) this.root.remove(o);
    this.obs.clear();
  }

  frame(rect: { w: number; h: number }) {
    const aspect = rect.w / Math.max(1, rect.h);
    this.camera.aspect = aspect;
    // Narrow halves need a wider vertical field of view to keep the road in frame.
    this.camera.fov = aspect < 0.7 ? 50 : aspect < 1.1 ? 42 : 36;
    // Behind and above the wheel, looking down at the road ahead, turned a little to one side.
    // The other player's side is its exact mirror image.
    const sx = this.mirrored ? 1 : -1;
    this.camera.position.set(sx * 2.6, 7.8, 7.6);
    this.camera.lookAt(sx * -0.3, 0.3, -6.5);
    this.camera.updateProjectionMatrix();
  }

  update(v: SideView, time: number) {
    const s = v.state;
    const dist = s.dist;
    this.setNight(v.night);

    for (let i = 0; i < PLANKS; i++) {
      const p = this.planks[i];
      const total = PLANKS * PLANK;
      const raw = (((i * PLANK - dist) % total) + total) % total;
      p.position.z = -(raw - 8);
    }
    for (const o of this.decor) {
      const raw = (((o.userData.z0 - dist * 1) % DECOR_SPAN) + DECOR_SPAN) % DECOR_SPAN;
      o.position.set(o.userData.x, 0, -(raw - 12));
      o.rotation.y = o.userData.rot;
    }

    // The wheel.
    const w = this.wheel;
    const lt = laneT(s);
    const x = LANE_X[0] + (LANE_X[1] - LANE_X[0]) * lt;
    let y = R + 0.06;
    if (s.air > 0) {
      const p = 1 - s.air / AIR_TICKS;
      y += 4 * p * (1 - p) * 1.4;
    }
    const wobble = s.stun > 0 && s.stunKind === STUN_CRASH ? Math.sin(time * 40) * 0.12 * (s.stun / 45) : 0;
    w.group.position.set(x, y, 0);
    w.group.rotation.z = wobble;
    w.spin.rotation.x = -dist / R;
    const hot = s.heat > 0.75 || s.stunKind === STUN_HEAT;
    w.rimMat.color.setHex(hot ? C.wheelHot : C.wheel);
    w.rimMat.emissive.setHex(s.boost > 0 ? 0x2bb8d6 : hot ? 0x550000 : 0x0a3a44);
    const stride = dist * 3.2;
    w.ham.feet.forEach((f, i) => {
      f.position.y = -0.36 + Math.max(0, Math.sin(stride + (i % 2 ? Math.PI : 0))) * 0.07 * Math.min(1, s.speed / 4);
    });
    const scared = s.stunKind === STUN_SCARED && s.stun > 0;
    w.ham.group.position.y = -R + 0.45 + Math.abs(Math.sin(stride)) * 0.04 * Math.min(1, s.speed / 6) + (scared ? 0.12 : 0);
    w.ham.group.scale.setScalar(scared ? 0.9 : 1);
    this.shadow.position.x = x;
    const hs = 1 / (1 + (y - R) * 0.6);
    this.shadow.scale.setScalar(hs);

    // Obstacles: build meshes the first time we see them, place them relative to the hamster.
    for (const o of v.course) {
      if (o.kind === 'cat') continue;
      let m = this.obs.get(o.id);
      const z = -(o.d - dist);
      if (z > 8 || z < -60) {
        if (m) m.visible = false;
        continue;
      }
      if (!m) {
        m = buildObstacle(o);
        this.obs.set(o.id, m);
        this.root.add(m);
      }
      m.visible = true;
      m.position.z = z;
      if (m.userData.spin) {
        m.rotation.y = time * 2 + o.id;
        m.position.y = (o.kind === 'bdrop' ? 1.0 : o.kind === 'seed' ? 0.32 : 0.22) + Math.sin(time * 3 + o.id) * 0.06;
      }
    }

    // The cat peeks in from the far side and stares.
    const cat = this.cat;
    if (s.catId >= 0) {
      cat.group.visible = true;
      const inT = Math.min(1, s.catT / CAT_TELE);
      cat.group.position.set(9 - 4.4 * inT, 1.3, -7);
      const open = catWatching(s);
      cat.eyes.forEach((e) => (e.visible = open));
      cat.lids.forEach((l) => (l.visible = !open));
      cat.group.rotation.z = open ? 0 : Math.sin(time * 6) * 0.05;
    } else {
      cat.group.visible = false;
    }

    // Distance signs every 50 m, finish gate.
    const base = Math.floor(dist / 50) * 50;
    this.signs.forEach((sp, i) => {
      const at = base + 50 * (i + 1);
      const z = -(at - dist);
      sp.visible = at < FINISH_M && z > -60;
      sp.position.set(-2.6, 1.2, z);
      if (sp.userData.at !== at) {
        sp.userData.at = at;
        const fresh = textSprite(`${at}M`);
        sp.material.map?.dispose();
        sp.material.map = (fresh.material as THREE.SpriteMaterial).map;
        sp.material.needsUpdate = true;
      }
    });
    const fz = -(FINISH_M - dist);
    this.finish.visible = fz > -60 && fz < 10;
    this.finish.position.z = fz;
  }
}

export interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Two mirrored worlds rendered side by side (or stacked on a portrait phone) into one pixelated canvas. */
export class Arena {
  readonly renderer: THREE.WebGLRenderer;
  readonly left = new SideWorld(false);
  readonly right = new SideWorld(true);
  private size = { w: 1, h: 1 };
  stacked = false;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(1);
    this.renderer.setScissorTest(true);
  }

  resize() {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(2, el.clientWidth);
    const h = Math.max(2, el.clientHeight);
    const px = w > 1400 ? PIXEL + 1 : PIXEL;
    this.size = { w: Math.floor(w / px), h: Math.floor(h / px) };
    this.renderer.setSize(this.size.w, this.size.h, false);
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

  render(me: SideView, opp: SideView, time: number) {
    const { w, h } = this.size;
    this.left.update(me, time);
    this.right.update(opp, time);
    const draw = (world: SideWorld, x: number, y: number, vw: number, vh: number) => {
      world.frame({ w: vw, h: vh });
      this.renderer.setViewport(x, y, vw, vh);
      this.renderer.setScissor(x, y, vw, vh);
      this.renderer.render(world.scene, world.camera);
    };
    if (this.stacked) {
      const half = Math.floor(h / 2);
      draw(this.left, 0, 0, w, half); // bottom (WebGL y goes up)
      draw(this.right, 0, half, w, h - half);
    } else {
      const half = Math.floor(w / 2);
      draw(this.left, 0, 0, half, h);
      draw(this.right, half, 0, w - half, h);
    }
  }

  resetCourse() {
    this.left.resetCourse();
    this.right.resetCourse();
  }
}
