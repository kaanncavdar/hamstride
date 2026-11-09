import * as THREE from 'three';
import { carD } from '../shared/course';
import { JUMP_TICKS, laneX, RIDE_BALL, RIDE_WHEEL, STUMBLE_TICKS, tired, type PState } from '../shared/sim';
import { Hamster } from './hamster';
import { buildBall, buildMiniWheel, buildObstacle, mesh, POST_FRAG, POST_VERT, Puffs, type SideView, type Viewport } from './scene';
import { beddingTex, corkTex, discTex, labelTex, ledBoard, tread6Tex } from './textures';

/**
 * The wide version: ONE big wheel with six lanes, three for each player, seen from behind like a
 * classic runner. The screen splits down the middle of the wheel: you run in the left three lanes,
 * your rival in the right three, on the same course. Ahead, the track curls up the inside of the
 * wheel, so what's coming rolls down towards you. Around the wheel is Squeektoshi's real set-up:
 * paper bedding, cork, a sand bath, the WHEELY9000 sensor, the stream camera, and an LED board
 * with his live numbers.
 */

const R = 9;
const LANE_W = 1.5;
const DEPTH = LANE_W * 6 + 0.5;
const FLOOR_Y = -R - 0.8;
const AHEAD = R * Math.PI * 1.05;
const GROW = 4;
const CYCLE_M = 420;

/** z of global lane 0..5 (0-2 = left player, 3-5 = right player). */
const laneZ = (g: number) => (g - 2.5) * LANE_W;
const trackZ = (track: 0 | 1, x: number) => laneZ(track * 3 + x);

function onRim(obj: THREE.Object3D, a: number, z: number) {
  const phi = a / R;
  obj.position.set(R * Math.sin(phi), -R * Math.cos(phi), z);
  obj.rotation.set(0, 0, phi);
}

function rnd(i: number) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function buildWheel() {
  const g = new THREE.Group();
  const spin = new THREE.Group();
  g.add(spin);
  const tread = tread6Tex().clone();
  tread.needsUpdate = true;
  tread.repeat.set(Math.round((2 * Math.PI * R) / 2.4), 1);
  const treadGeo = new THREE.CylinderGeometry(R, R, DEPTH, 200, 1, true);
  treadGeo.rotateX(Math.PI / 2);
  const inner = new THREE.Mesh(treadGeo, new THREE.MeshStandardMaterial({ map: tread, roughness: 0.55, side: THREE.BackSide }));
  inner.receiveShadow = true;
  spin.add(inner);
  const outerGeo = new THREE.CylinderGeometry(R + 0.22, R + 0.22, DEPTH, 200, 1, true);
  outerGeo.rotateX(Math.PI / 2);
  spin.add(new THREE.Mesh(outerGeo, new THREE.MeshStandardMaterial({ color: '#7f9ab3', roughness: 0.4 })));
  const lipMat = new THREE.MeshStandardMaterial({ color: '#5b7795', roughness: 0.35 });
  for (const z of [DEPTH / 2, -DEPTH / 2]) {
    const lip = new THREE.Mesh(new THREE.TorusGeometry(R + 0.1, 0.18, 12, 200), lipMat);
    lip.position.z = z;
    spin.add(lip);
  }
  // Both sides are clear acrylic, so you can see the cage around you; the hub carries the logo.
  for (const z of [-DEPTH / 2 - 0.02, DEPTH / 2 + 0.02]) {
    const side = new THREE.Mesh(
      new THREE.CircleGeometry(R + 0.2, 128),
      new THREE.MeshPhysicalMaterial({ color: '#dff1ff', transparent: true, opacity: 0.16, roughness: 0.08, depthWrite: false, side: THREE.DoubleSide }),
    );
    side.position.z = z;
    spin.add(side);
    const hub = new THREE.Mesh(new THREE.CircleGeometry(R * 0.32, 64), new THREE.MeshStandardMaterial({ map: discTex(), roughness: 0.5, side: THREE.DoubleSide }));
    hub.position.z = z;
    hub.renderOrder = 1;
    spin.add(hub);
    for (let i = 0; i < 8; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.16, R - R * 0.32, 0.08), lipMat);
      const a = (i / 8) * Math.PI * 2;
      const r = (R + R * 0.32) / 2;
      spoke.position.set(Math.cos(a) * r, Math.sin(a) * r, z);
      spoke.rotation.z = a - Math.PI / 2;
      spin.add(spoke);
    }
  }
  const magnet = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.28, 0.24), new THREE.MeshStandardMaterial({ color: '#f4f4f4', roughness: 0.3 }));
  magnet.position.set(0, -(R + 0.34), DEPTH / 2 - 0.4);
  spin.add(magnet);

  // Stand and axle, outside the left wall.
  const steel = new THREE.MeshStandardMaterial({ color: '#8d99a6', roughness: 0.3, metalness: 0.6 });
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 4.2, 20), steel);
  axle.rotation.x = Math.PI / 2;
  axle.position.z = -DEPTH / 2 - 2.1;
  g.add(axle);
  // One leg leaning forward and one straight down, so nothing stands in front of the camera.
  const len = Math.hypot(R * 0.75, -FLOOR_Y);
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, len, 14), steel);
  leg.position.set((R * 0.75) / 2, FLOOR_Y / 2, -DEPTH / 2 - 4);
  leg.rotation.z = Math.atan2(R * 0.75, -FLOOR_Y);
  g.add(leg);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, -FLOOR_Y, 14), steel);
  post.position.set(0.6, FLOOR_Y / 2, -DEPTH / 2 - 4);
  g.add(post);
  // The WHEELY9000 sensor by the magnet's path, with its LED.
  const sensor = new THREE.Group();
  sensor.add(new THREE.Mesh(new THREE.BoxGeometry(1, 0.6, 0.5), new THREE.MeshStandardMaterial({ color: '#2b2f3a', roughness: 0.5 })));
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), new THREE.MeshStandardMaterial({ color: '#1b3a22', emissive: '#39ff7a', emissiveIntensity: 0 }));
  led.position.set(0.3, 0.12, 0.27);
  sensor.add(led);
  const sensorA = -0.35;
  sensor.position.set(Math.sin(sensorA) * (R + 0.85), -Math.cos(sensorA) * (R + 0.85), DEPTH / 2 - 0.4);
  sensor.rotation.z = sensorA;
  g.add(sensor);
  return { group: g, spin, led: led.material as THREE.MeshStandardMaterial, sensorA };
}

/** The enclosure and the live-stream rig around it. */
function buildSet(scene: THREE.Object3D) {
  const bedTex = beddingTex().clone();
  bedTex.needsUpdate = true;
  bedTex.repeat.set(12, 12);
  const bedMat = new THREE.MeshStandardMaterial({ map: bedTex, roughness: 1 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), bedMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.receiveShadow = true;
  scene.add(floor);
  for (let i = 0; i < 40; i++) {
    const side = i % 2 ? 1 : -1;
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), bedMat);
    m.scale.set(1.5 + rnd(i + 9) * 3, 0.4 + rnd(i + 3) * 0.9, 1.2 + rnd(i + 7) * 2.4);
    m.position.set(-14 + rnd(i) * 34, FLOOR_Y, side * (DEPTH / 2 + 2 + rnd(i + 50) * 14));
    m.receiveShadow = true;
    scene.add(m);
  }
  const bits = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.4, 0.13), new THREE.MeshStandardMaterial({ color: '#fbf6ec', side: THREE.DoubleSide }), 700);
  const tmp = new THREE.Object3D();
  for (let i = 0; i < 700; i++) {
    const side = i % 2 ? 1 : -1;
    tmp.position.set(-16 + rnd(i * 3) * 40, FLOOR_Y + 0.03 + rnd(i * 5) * 0.1, side * (DEPTH / 2 + 0.8 + rnd(i * 7) * 18));
    tmp.rotation.set(-Math.PI / 2 + (rnd(i) - 0.5) * 0.6, 0, rnd(i * 11) * Math.PI);
    tmp.updateMatrix();
    bits.setMatrixAt(i, tmp.matrix);
  }
  scene.add(bits);

  // Left side: cork hide, cardboard tunnel, chew sticks. Right side: sand bath, water bowl, seeds.
  const cork = new THREE.MeshStandardMaterial({ map: corkTex(), roughness: 0.95, side: THREE.DoubleSide });
  const hideGeo = new THREE.CylinderGeometry(2.2, 2.2, 4, 28, 1, true, 0, Math.PI);
  hideGeo.rotateX(Math.PI / 2);
  const hide = mesh(hideGeo, cork);
  hide.position.set(4, FLOOR_Y, -DEPTH / 2 - 5);
  hide.rotation.y = 0.4;
  scene.add(hide);
  const card = new THREE.MeshStandardMaterial({ color: '#b98a55', roughness: 0.9, side: THREE.DoubleSide });
  const tube = mesh(new THREE.CylinderGeometry(1.1, 1.1, 5, 24, 1, true), card);
  tube.rotation.z = Math.PI / 2;
  tube.rotation.y = 0.5;
  tube.position.set(-6, FLOOR_Y + 1, -DEPTH / 2 - 6);
  scene.add(tube);
  const chewMat = new THREE.MeshStandardMaterial({ color: '#c79a63', roughness: 0.8 });
  for (let i = 0; i < 6; i++) {
    const c = mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.2, 8), chewMat);
    c.rotation.set(Math.PI / 2, 0, rnd(i) * 3);
    c.position.set(10 + rnd(i + 4) * 4, FLOOR_Y + 0.15 + i * 0.05, -DEPTH / 2 - 3 - rnd(i + 8) * 3);
    scene.add(c);
  }
  const bath = mesh(new THREE.CylinderGeometry(2.6, 2.3, 0.7, 40), new THREE.MeshStandardMaterial({ color: '#d7c6ef', roughness: 0.4 }));
  bath.position.set(3, FLOOR_Y + 0.35, DEPTH / 2 + 5);
  scene.add(bath);
  const sand = new THREE.Mesh(new THREE.CircleGeometry(2.4, 40), new THREE.MeshStandardMaterial({ color: '#e8d6a8', roughness: 1 }));
  sand.rotation.x = -Math.PI / 2;
  sand.position.set(3, FLOOR_Y + 0.72, DEPTH / 2 + 5);
  scene.add(sand);
  const bowl = mesh(new THREE.CylinderGeometry(1.4, 1.1, 0.75, 32), new THREE.MeshStandardMaterial({ color: '#e9eef2', roughness: 0.2 }));
  bowl.position.set(-5, FLOOR_Y + 0.38, DEPTH / 2 + 4);
  scene.add(bowl);
  const water = new THREE.Mesh(new THREE.CircleGeometry(1.25, 32), new THREE.MeshStandardMaterial({ color: '#8fc8e8', roughness: 0.05, metalness: 0.2 }));
  water.rotation.x = -Math.PI / 2;
  water.position.set(-5, FLOOR_Y + 0.66, DEPTH / 2 + 4);
  scene.add(water);
  const seedMat = new THREE.MeshStandardMaterial({ color: '#2b2622', roughness: 0.5 });
  const seeds = new THREE.InstancedMesh(new THREE.SphereGeometry(0.1, 8, 6), seedMat, 60);
  for (let i = 0; i < 60; i++) {
    tmp.position.set(9 + rnd(i * 13) * 5, FLOOR_Y + 0.06, DEPTH / 2 + 2 + rnd(i * 17) * 4);
    tmp.rotation.set(0, rnd(i) * 3, 0);
    tmp.scale.set(1.6, 0.6, 0.7);
    tmp.updateMatrix();
    seeds.setMatrixAt(i, tmp.matrix);
  }
  scene.add(seeds);

  // The glass tank around everything.
  const glassMat = new THREE.MeshPhysicalMaterial({ color: '#cfe6ee', transparent: true, opacity: 0.18, roughness: 0.05, depthWrite: false, side: THREE.DoubleSide });
  for (const z of [-22, 22]) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(80, 26), glassMat);
    wall.position.set(4, FLOOR_Y + 13, z);
    scene.add(wall);
  }
  const back = new THREE.Mesh(new THREE.PlaneGeometry(60, 26), glassMat);
  back.rotation.y = -Math.PI / 2;
  back.position.set(26, FLOOR_Y + 13, 0);
  scene.add(back);
  const room = new THREE.Mesh(new THREE.PlaneGeometry(200, 80), new THREE.MeshStandardMaterial({ color: '#d9cbb6', roughness: 1 }));
  room.rotation.y = -Math.PI / 2;
  room.position.set(60, FLOOR_Y + 30, 0);
  scene.add(room);

  // The stream camera on a clamp, watching the wheel: lens, IR lamp ring and a REC light.
  const cams: { rec: THREE.MeshStandardMaterial; ir: THREE.MeshStandardMaterial }[] = [];
  for (const side of [-1, 1]) {
    const rig = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: '#23262d', roughness: 0.4, metalness: 0.3 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 6, 10), dark);
    pole.position.y = 3;
    rig.add(pole);
    const head = new THREE.Group();
    head.position.y = 6.2;
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.9, 0.9), new THREE.MeshStandardMaterial({ color: '#f3f3f1', roughness: 0.35 }));
    head.add(body);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.4, 24), dark);
    lens.rotation.z = Math.PI / 2;
    lens.position.x = -0.8;
    head.add(lens);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.26, 24), new THREE.MeshStandardMaterial({ color: '#0d1b2a', roughness: 0.05, metalness: 0.6 }));
    glass.rotation.y = -Math.PI / 2;
    glass.position.x = -1.01;
    head.add(glass);
    const ir = new THREE.MeshStandardMaterial({ color: '#3a1010', emissive: '#ff3b3b', emissiveIntensity: 0 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const d = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), ir);
      d.position.set(-1.0, Math.sin(a) * 0.4, Math.cos(a) * 0.4);
      head.add(d);
    }
    const rec = new THREE.MeshStandardMaterial({ color: '#400', emissive: '#ff2030', emissiveIntensity: 1 });
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), rec);
    dot.position.set(-0.66, 0.32, 0.3 * side);
    head.add(dot);
    head.rotation.y = side * 0.7;
    head.rotation.z = -0.35;
    rig.add(head);
    rig.position.set(12, FLOOR_Y, side * (DEPTH / 2 + 7));
    scene.add(rig);
    cams.push({ rec, ir });
  }

  // The LED board with Squeektoshi's live numbers, one on each side.
  const board = ledBoard(120);
  for (const side of [-1, 1]) {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.5, 12.4), new THREE.MeshStandardMaterial({ color: '#1b1d22', roughness: 0.6 }));
    const face = new THREE.Mesh(new THREE.PlaneGeometry(12, 1.1), new THREE.MeshBasicMaterial({ map: board.tex, toneMapped: false }));
    face.rotation.y = -Math.PI / 2;
    face.position.x = -0.16;
    const g = new THREE.Group();
    g.add(frame, face);
    g.position.set(17, FLOOR_Y + 5.5, side * (DEPTH / 2 + 8.5));
    g.rotation.y = side * 0.5;
    scene.add(g);
  }
  return { cams, board };
}

class WideWorld {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.2, 220);
  nightMix = 0;
  flash = 0;
  private root = new THREE.Group();
  private wheel = buildWheel();
  private set: ReturnType<typeof buildSet>;
  private me = new Hamster();
  private other = new Hamster();
  private otherTag: THREE.Sprite;
  private otherName = '';
  private rides = { wheel: [buildMiniWheel(1.25), buildMiniWheel(1.25)], ball: [buildBall(1.05), buildBall(1.05)] };
  private shadows: THREE.Mesh[] = [];
  private obs = new Map<string, THREE.Object3D>();
  private puffs: Puffs;
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private ir: THREE.PointLight;
  private lamp: THREE.PointLight;
  private bgDay = new THREE.Color('#efe3cf');
  private bgNight = new THREE.Color('#0a0d0b');
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

  /** track 0 = this half shows the left lanes, 1 = the right lanes. */
  constructor(private track: 0 | 1) {
    this.scene.add(this.root);
    this.scene.background = this.bgDay.clone();
    this.scene.fog = new THREE.Fog(this.bgDay.getHex(), 40, 95);
    this.hemi = new THREE.HemisphereLight('#fff3df', '#8a7a68', 1.35);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff1d8', 2.3);
    this.sun.position.set(-6, 8, trackZ(track, 1) + 4);
    this.sun.target.position.set(4, -R, trackZ(track, 1));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.left = -10;
    sc.right = 10;
    sc.top = 10;
    sc.bottom = -10;
    sc.near = 1;
    sc.far = 40;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);
    this.ir = new THREE.PointLight('#ffffff', 0, 40, 1.2);
    this.scene.add(this.ir);
    this.lamp = new THREE.PointLight('#ffffff', 0, 9, 1.4);
    this.root.add(this.lamp);

    this.root.add(this.wheel.group);
    this.set = buildSet(this.root);
    for (const h of [this.me, this.other]) {
      h.group.scale.setScalar(1.25);
      this.root.add(h.group);
    }
    this.otherTag = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex('RIVAL'), transparent: true, depthWrite: false }));
    this.otherTag.scale.set(1.8, 0.5, 1);
    this.root.add(this.otherTag);
    for (const r of [...this.rides.wheel, ...this.rides.ball]) {
      r.visible = false;
      this.root.add(r);
    }
    for (let i = 0; i < 2; i++) {
      const sh = new THREE.Mesh(new THREE.CircleGeometry(0.8, 24), new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.22, depthWrite: false }));
      sh.rotation.x = -Math.PI / 2;
      this.root.add(sh);
      this.shadows.push(sh);
    }
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
    this.camera.fov = aspect < 0.75 ? 78 : aspect < 1.05 ? 68 : 60;
    const j = this.shake * 0.22;
    // Behind and above your hamster, looking down the middle of your three lanes and up the wheel.
    this.camera.position.set(-5.6 + (Math.random() - 0.5) * j, -R + 3.6 + (Math.random() - 0.5) * j, this.camZ);
    this.camera.lookAt(7.5, -R + 2.6, this.camZ);
    this.camera.updateProjectionMatrix();
    this.ir.position.copy(this.camera.position);
  }

  /** Places one hamster (and its ride, shadow) for a state at `a` metres ahead on the rim. */
  private placeRunner(h: Hamster, s: PState, a: number, slot: 0 | 1, rest: number, bump: number, dt: number, time: number) {
    const track = slot === 0 ? this.track : ((1 - this.track) as 0 | 1);
    const z = trackZ(track, laneX(s));
    const jump = s.air > 0 ? 1 - s.air / JUMP_TICKS : -1;
    const hop = jump >= 0 ? 4 * jump * (1 - jump) * 1.6 : 0;
    const lift = hop + (s.ride === RIDE_BALL ? 0.35 : s.ride === RIDE_WHEEL ? 0.12 : 0);
    onRim(h.group, a, z);
    h.group.position.y += lift * Math.cos(a / R);
    h.group.position.x -= lift * Math.sin(a / R);
    h.update(
      { speed: tired(s) ? 0 : s.speed, jump, sliding: s.slide > 0 && s.air === 0, bump, rest, puffed: s.energy === 1 && !tired(s), night: this.nightMix },
      dt,
      time,
    );
    const sh = this.shadows[slot];
    onRim(sh, a, z);
    sh.position.y += 0.03;
    sh.rotation.set(-Math.PI / 2, 0, 0);
    sh.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), a / R);
    sh.scale.setScalar(1 / (1 + hop * 0.6));
    const w = this.rides.wheel[slot];
    const b = this.rides.ball[slot];
    w.visible = s.ride === RIDE_WHEEL && h.group.visible;
    b.visible = s.ride === RIDE_BALL && h.group.visible;
    if (w.visible) {
      onRim(w, a, z);
      w.rotateY(Math.PI / 2);
      (w.userData.spin as THREE.Object3D).rotation.z = -s.dist * 1.6;
    }
    if (b.visible) {
      onRim(b, a, z);
      b.position.y += (1.05 + hop) * Math.cos(a / R);
      b.rotation.z = -s.dist / 1.05;
    }
    return z;
  }

  update(v: SideView, time: number) {
    const s = v.state;
    const dt = Math.min(0.05, Math.max(0, time - this.lastT));
    this.lastT = time;
    const isTired = tired(s);

    // Day and night take turns; the switch flashes like the stream camera changing mode.
    const wantNight = Math.floor(s.dist / CYCLE_M) % 2 === 1 ? 1 : 0;
    const before = this.nightMix;
    this.nightMix += Math.sign(wantNight - this.nightMix) * Math.min(Math.abs(wantNight - this.nightMix), dt * 1.4);
    this.flash = before !== this.nightMix ? Math.sin(Math.PI * this.nightMix) * 0.9 : 0;
    const n = this.nightMix;
    (this.scene.background as THREE.Color).copy(this.bgDay).lerp(this.bgNight, n);
    (this.scene.fog as THREE.Fog).color.copy(this.scene.background as THREE.Color);
    this.hemi.intensity = 1.35 * (1 - n) + 0.1 * n;
    this.sun.intensity = 2.3 * (1 - n) + 0.12 * n;
    this.ir.intensity = 26 * n;
    this.lamp.intensity = 7 * n;
    for (const c of this.set.cams) {
      c.ir.emissiveIntensity = 2.5 * n;
      c.rec.emissiveIntensity = Math.floor(time * 1.2) % 2 ? 2 : 0.2;
    }
    if (v.ticker) this.set.board.set(v.ticker);
    this.set.board.tick(dt);

    // When the hamster stops, the wheel coasts on and slows down.
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

    const turn = -dist / R;
    this.wheel.spin.rotation.z = turn;
    const TAU = Math.PI * 2;
    const diff = Math.abs((((turn - this.wheel.sensorA) % TAU) + TAU) % TAU);
    this.wheel.led.emissiveIntensity = diff < 0.12 || diff > TAU - 0.12 ? 3 : Math.max(0, this.wheel.led.emissiveIntensity - dt * 6);

    // You, at the bottom of the wheel in your three lanes.
    const z = this.placeRunner(this.me, s, 0, 0, this.rest, this.bump, dt, time);
    this.camZ += (trackZ(this.track, 1) + (z - trackZ(this.track, 1)) * 0.45 - this.camZ) * Math.min(1, dt * 5);
    this.lamp.position.set(-1.6, -R + 2.8, z);

    // Your rival, in the other three lanes, where they really are relative to you.
    const o = v.ghost;
    const oa = o ? o.dist - s.dist : 0;
    const showOther = !!o && oa < AHEAD * 0.8 && oa > -4;
    this.other.group.visible = showOther;
    this.otherTag.visible = showOther;
    this.shadows[1].visible = showOther;
    if (o && showOther) {
      const oz = this.placeRunner(this.other, o, oa, 1, tired(o) ? 1 : 0, 0, dt, time);
      this.otherTag.position.copy(this.other.group.position).add(new THREE.Vector3(-Math.sin(oa / R) * 2.1, Math.cos(oa / R) * 2.1, 0));
      void oz;
      if (v.ghostName && v.ghostName !== this.otherName) {
        this.otherName = v.ghostName;
        this.otherTag.material.map?.dispose();
        this.otherTag.material.map = labelTex(v.ghostName.slice(0, 10).toUpperCase());
        this.otherTag.material.needsUpdate = true;
      }
    } else {
      this.rides.wheel[1].visible = false;
      this.rides.ball[1].visible = false;
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
    if (!isTired && s.air === 0) {
      this.stepAcc += dt * s.speed * 0.6;
      if (this.stepAcc > 1) {
        this.stepAcc = 0;
        const sliding = s.slide > 0;
        this.puffs.emit(feet.clone().add(new THREE.Vector3(-0.5, 0, 0)), sliding ? 4 : 1, 0.3, 0.8, 0.45, n > 0.5 ? '#cfd8cf' : '#efe2c8', sliding ? 0.3 : 0.18, s.speed * 0.4);
      }
    }
    this.puffs.tick(dt);
    this.shake = Math.max(0, this.shake - dt * 3);
    this.bump = Math.max(0, this.bump - dt * (60 / STUMBLE_TICKS));

    // The same course in both halves of the wheel. Treats you ran through disappear from your lanes.
    for (const ob of v.course) {
      const front = ob.kind === 'car' ? carD(ob, s.dist) : ob.d;
      const a = front - dist;
      const treat = ob.kind === 'worm' || ob.kind === 'wheel' || ob.kind === 'ball' || ob.kind === 'bdrop';
      for (const slot of [0, 1] as const) {
        const key = `${ob.id}:${slot}`;
        let m = this.obs.get(key);
        // In the rival's lanes, the rolling balls are where they are for the rival.
        const aa = slot === 0 ? a : ob.kind === 'car' && o ? carD(ob, o.dist) - dist : a;
        if (aa > AHEAD || aa < -4) {
          if (m) m.visible = false;
          continue;
        }
        if (!m) {
          m = buildObstacle(ob);
          this.obs.set(key, m);
          this.root.add(m);
        }
        const runner = slot === 0 ? s : o;
        const track = slot === 0 ? this.track : ((1 - this.track) as 0 | 1);
        const eaten = treat && !!runner && ob.d - runner.dist < 0.2 && Math.abs(laneX(runner) - ob.lane) < 0.45;
        m.visible = !eaten;
        onRim(m, aa, trackZ(track, ob.lane));
        m.scale.setScalar(Math.min(1, Math.max(0.01, (AHEAD - aa) / GROW)));
        const fl = m.userData.float as THREE.Object3D | undefined;
        if (fl) {
          fl.rotation.y = time * 2 + ob.id;
          fl.position.y = (ob.kind === 'bdrop' ? 0.75 : ob.kind === 'wheel' ? 0.66 : 0.55) + Math.sin(time * 3 + ob.id) * 0.08;
        }
        const roll = m.userData.roll as THREE.Object3D | undefined;
        if (roll) roll.rotation.z = (ob.d - (slot === 0 ? front : aa + dist)) / 0.72;
      }
      if (ob.d - dist > AHEAD + 80) break;
    }
  }
}

/** One six-lane wheel, split down the middle: you on the left, your rival on the right. */
export class WideArena {
  readonly renderer: THREE.WebGLRenderer;
  readonly left = new WideWorld(0);
  readonly right = new WideWorld(1);
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
      uniforms: { tScene: { value: null }, uNight: { value: 0 }, uFlash: { value: 0 }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) } },
      depthTest: false,
      depthWrite: false,
    });
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.post));
  }

  /** Render at a fraction of the screen's resolution (1 = full, capped at 1.75x) to keep the frame rate up. */
  setQuality(scale: number) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75) * scale);
    this.resize();
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

  halves(): [Viewport, Viewport] {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (this.stacked) {
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

  nights(): [number, number] {
    return [this.left.nightMix, this.right.nightMix];
  }

  render(me: SideView, opp: SideView, time: number) {
    const { w, h } = this.size;
    const pr = this.renderer.getPixelRatio();
    this.left.update(me, time);
    this.right.update(opp, time);
    const draw = (world: WideWorld, rt: THREE.WebGLRenderTarget, x: number, y: number, vw: number, vh: number) => {
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
      draw(this.left, this.targets[0], 0, 0, w, half);
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
