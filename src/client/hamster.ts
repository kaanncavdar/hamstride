import * as THREE from 'three';
import { furTex } from './textures';

/**
 * Squeektoshi, a white-and-orange Syrian hamster: one soft body with cheek pouches, real fur
 * (stacked "shell" layers), glossy eyes that shine on the night camera, pink paws, and a run, jump,
 * slide, bump and rest animation driven from the race state.
 */

const WHITE = new THREE.Color('#fff8ef');
const ORANGE = new THREE.Color('#e8913f');
const GINGER = new THREE.Color('#c96f2a');
const PINK = '#f2a9b4';
const SHELLS = 12;
const FUR_LEN = 0.075;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Where the body surface is in a direction from its centre (x forward, y up). */
function surface(d: THREE.Vector3): THREE.Vector3 {
  const { x, y, z } = d;
  const head = smooth(0.15, 0.95, x);
  const rear = smooth(0.2, 1, -x);
  let px = x * 0.64;
  let py = y * 0.5 * (1 - 0.14 * head) * (1 + 0.06 * rear);
  let pz = z * 0.53 * (1 - 0.22 * head) * (1 + 0.08 * rear);
  // Cheek pouches.
  const cheek = Math.exp(-((x - 0.62) ** 2 + (y + 0.12) ** 2) / 0.045);
  pz *= 1 + cheek * 0.28;
  py -= cheek * 0.02;
  // Pointy-ish nose.
  px += smooth(0.85, 1, x) * 0.05 * (1 - Math.abs(y));
  // Flat belly.
  if (py < -0.36) py = -0.36 + (py + 0.36) * 0.35;
  return new THREE.Vector3(px, py, pz);
}

let bodyGeo: THREE.BufferGeometry | null = null;

function buildBody(): THREE.BufferGeometry {
  if (bodyGeo) return bodyGeo;
  const g = new THREE.SphereGeometry(1, 72, 48);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    // Coat: white underneath and on the muzzle, orange over the back and head, a white blaze between the eyes.
    const n = Math.sin(v.x * 9.1 + v.z * 4.3) * 0.08 + Math.sin(v.z * 11.7 - v.y * 5.2) * 0.06;
    let orange = smooth(-0.15, 0.12, v.y + n);
    orange *= 1 - smooth(0.78, 0.92, v.x) * smooth(-0.1, 0.25, -v.y + 0.25);
    const blaze = smooth(0.18, 0.06, Math.abs(v.z)) * smooth(0.35, 0.6, v.x);
    orange *= 1 - blaze;
    orange = Math.max(orange, smooth(0.5, 0.62, v.x) * smooth(0.0, 0.25, v.y) * (1 - blaze) * smooth(0.95, 0.85, v.x));
    c.copy(WHITE).lerp(v.y > 0.55 ? GINGER : ORANGE, orange);
    colors.set([c.r, c.g, c.b], i * 3);
    const p = surface(v);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  // Weld the normals along the sphere's seam so there is no crease.
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  const sum = new Map<string, THREE.Vector3>();
  const key = (i: number) => `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    const s = sum.get(k) ?? new THREE.Vector3();
    s.add(new THREE.Vector3().fromBufferAttribute(nrm, i));
    sum.set(k, s);
  }
  for (let i = 0; i < pos.count; i++) {
    const s = sum.get(key(i))!.clone().normalize();
    nrm.setXYZ(i, s.x, s.y, s.z);
  }
  bodyGeo = g;
  return g;
}

/** One fur layer: the body pushed out along its normals, with hairs cut out of it by a strand map. */
function furMaterial(layer: number, night: { value: number }) {
  const h = layer / SHELLS;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uShell = { value: h };
    sh.uniforms.uFurLen = { value: FUR_LEN };
    sh.uniforms.uStrands = { value: furTex() };
    sh.uniforms.uNight = night;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uShell; uniform float uFurLen; varying vec2 vFurUv;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        transformed += normal * uShell * uFurLen;
        transformed.y -= uShell * uShell * 0.025;
        vFurUv = uv * vec2(7.0, 5.0);`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uShell; uniform float uNight; uniform sampler2D uStrands; varying vec2 vFurUv;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (uShell > 0.0) {
          float strand = (texture2D(uStrands, vFurUv).r - 0.4) / 0.6;
          if (strand < uShell) discard;
        }
        diffuseColor.rgb *= mix(0.55, 1.08, uShell);`,
      )
      // Fur glows under the infrared lamp, like the real night stream.
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * uNight * 0.55;');
  };
  m.customProgramCacheKey = () => 'fur-shell';
  return m;
}

export interface Pose {
  /** Running speed, m/s (drives the stride). */
  speed: number;
  /** 0..1 through a jump, or -1 on the ground. */
  jump: number;
  sliding: boolean;
  /** 1 right after a bump, fading to 0. */
  bump: number;
  /** 0 = fresh, 1 = sat down to rest. */
  rest: number;
  /** 1 bolt left: a bit puffed out. */
  puffed: boolean;
  night: number;
}

export class Hamster {
  readonly group = new THREE.Group();
  /** Moves with jumps and bobs; the feet stay below it. */
  readonly body = new THREE.Group();
  private blob = new THREE.Group();
  private feet: THREE.Mesh[] = [];
  private ears: THREE.Object3D[] = [];
  private eyes: THREE.Mesh[] = [];
  private sweat: THREE.Mesh;
  private stars = new THREE.Group();
  private night = { value: 0 };
  private eyeMat: THREE.MeshPhongMaterial;
  private phase = 0;
  private landing = 0;
  private wasAir = false;

  constructor(ghost = false) {
    const geo = buildBody();
    this.group.add(this.body);
    this.body.add(this.blob);
    this.blob.position.y = 0.5;
    if (ghost) {
      const m = new THREE.MeshStandardMaterial({ color: '#9fdcff', transparent: true, opacity: 0.38, depthWrite: false, roughness: 0.6 });
      this.blob.add(new THREE.Mesh(geo, m));
    } else {
      for (let i = 0; i <= SHELLS; i++) {
        const mesh = new THREE.Mesh(geo, furMaterial(i, this.night));
        mesh.castShadow = i === 0;
        mesh.renderOrder = i;
        this.blob.add(mesh);
      }
    }
    const pink = ghost
      ? new THREE.MeshStandardMaterial({ color: '#9fdcff', transparent: true, opacity: 0.38, depthWrite: false })
      : new THREE.MeshStandardMaterial({ color: PINK, roughness: 0.55 });
    const earInner = new THREE.MeshStandardMaterial({ color: '#e98d9b', roughness: 0.6, side: THREE.DoubleSide });
    const earOuter = new THREE.MeshStandardMaterial({ color: '#d98a4e', roughness: 0.9 });

    // Ears: little rounded cups.
    for (const s of [-1, 1]) {
      const at = surface(new THREE.Vector3(0.38, 0.84, 0.4 * s).normalize());
      const ear = new THREE.Group();
      ear.position.copy(at).add(new THREE.Vector3(0, FUR_LEN * 0.9, 0));
      const cup = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), ghost ? pink : earOuter);
      cup.scale.set(0.55, 1, 1);
      cup.rotation.z = -Math.PI / 2;
      const inner = new THREE.Mesh(new THREE.CircleGeometry(0.105, 20), ghost ? pink : earInner);
      inner.position.x = 0.012;
      inner.rotation.y = Math.PI / 2;
      inner.scale.set(1, 1, 1);
      ear.add(cup, inner);
      ear.rotation.set(0.35 * s, 0, 0.25);
      this.blob.add(ear);
      this.ears.push(ear);
    }

    // Eyes: glossy black beads with a catch-light; they glow on the night camera.
    this.eyeMat = new THREE.MeshPhongMaterial({ color: '#0d0a0c', specular: '#ffffff', shininess: 140, emissive: '#000000' });
    const glint = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    for (const s of [-1, 1]) {
      const dir = new THREE.Vector3(0.74, 0.3, 0.42 * s).normalize();
      const at = surface(dir);
      // Sit the eye on top of the fur so no hairs grow over it.
      const out = at.clone().normalize();
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.078, 20, 14), ghost ? pink : this.eyeMat);
      eye.position.copy(at).addScaledVector(out, FUR_LEN * 0.55);
      eye.scale.set(0.8, 1, 0.8);
      const g = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), glint);
      g.position.set(0.04, 0.03, 0.03 * s);
      eye.add(g);
      this.blob.add(eye);
      this.eyes.push(eye);
    }

    // Nose, whiskers, tail.
    const noseAt = surface(new THREE.Vector3(1, -0.02, 0));
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 10), pink);
    nose.position.copy(noseAt).add(new THREE.Vector3(FUR_LEN * 0.6, 0, 0));
    nose.scale.set(0.8, 0.7, 1);
    this.blob.add(nose);
    if (!ghost) {
      const pts: number[] = [];
      for (const s of [-1, 1])
        for (let i = 0; i < 3; i++) {
          const y = noseAt.y - 0.03 + (i - 1) * 0.03;
          pts.push(noseAt.x - 0.06, y, 0.08 * s, noseAt.x - 0.02 + i * 0.02, y + (i - 1) * 0.06, (0.38 + i * 0.03) * s);
        }
      const wg = new THREE.BufferGeometry();
      wg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.blob.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: '#d8d2cc', transparent: true, opacity: 0.8 })));
      const tail = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), pink);
      tail.position.copy(surface(new THREE.Vector3(-1, 0.1, 0)));
      this.blob.add(tail);
    }

    // Paws: two little front hands, two longer back feet.
    const paw = new THREE.SphereGeometry(0.075, 14, 10);
    for (const [x, z, sx] of [[0.32, 0.18, 1], [0.32, -0.18, 1], [-0.28, 0.22, 1.6], [-0.28, -0.22, 1.6]]) {
      const f = new THREE.Mesh(paw, pink);
      f.scale.set(sx, 0.55, 0.85);
      f.position.set(x, 0.05, z);
      f.castShadow = !ghost;
      f.userData.home = new THREE.Vector3(x, 0.05, z);
      this.body.add(f);
      this.feet.push(f);
    }

    // A sweat drop and little dizzy stars for bumps.
    this.sweat = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshPhongMaterial({ color: '#bfe6ff', shininess: 120, transparent: true, opacity: 0.9 }));
    this.sweat.scale.set(0.7, 1.2, 0.7);
    this.sweat.visible = false;
    this.blob.add(this.sweat);
    const starMat = new THREE.MeshBasicMaterial({ color: '#ffd84d' });
    for (let i = 0; i < 3; i++) {
      const st = new THREE.Mesh(new THREE.OctahedronGeometry(0.06, 0), starMat);
      st.position.set(Math.cos((i / 3) * Math.PI * 2) * 0.32, 0, Math.sin((i / 3) * Math.PI * 2) * 0.32);
      this.stars.add(st);
    }
    this.stars.position.set(0.25, 0.6, 0);
    this.stars.visible = false;
    this.blob.add(this.stars);
  }

  update(p: Pose, dt: number, time: number) {
    this.night.value = p.night;
    this.eyeMat.emissive.setScalar(p.night * 0.85);

    // Stride: about 5 bounds a second at the start, quicker as you speed up, slower as you tire.
    const tiredK = 1 - p.rest;
    this.phase += dt * (6 + p.speed * 0.55) * tiredK;
    const ph = this.phase;
    const air = p.jump >= 0;
    if (this.wasAir && !air) this.landing = 1;
    this.wasAir = air;
    this.landing = Math.max(0, this.landing - dt * 5);

    // Body: a bounding gait, squashing as it lands and stretching as it pushes off.
    const bound = air ? 0 : Math.abs(Math.sin(ph)) * 0.07 * tiredK;
    let sy = 1 + Math.sin(ph * 2) * 0.045 * tiredK;
    let sx = 1 - Math.sin(ph * 2) * 0.035 * tiredK;
    let pitch = Math.cos(ph) * 0.06 * tiredK;
    if (air) {
      const t = p.jump;
      sy = t < 0.2 ? 1.12 : t > 0.85 ? 0.92 : 1.02;
      sx = t < 0.2 ? 0.92 : 1.02;
      pitch = (0.5 - t) * 0.5;
    }
    if (this.landing > 0) {
      sy -= this.landing * 0.16;
      sx += this.landing * 0.1;
    }
    if (p.sliding) {
      sy = 0.62;
      sx = 1.28;
      pitch = 0.08;
    }
    // Resting: sits back on its haunches, breathing hard.
    if (p.rest > 0) {
      const breathe = Math.sin(time * 7) * 0.04 * p.rest;
      sy = sy * (1 - p.rest) + (1.05 + breathe) * p.rest;
      sx = sx * (1 - p.rest) + (0.96 - breathe * 0.5) * p.rest;
      pitch = pitch * (1 - p.rest) - 0.42 * p.rest;
    }
    this.blob.scale.set(sx, sy, 1 / Math.sqrt(sx * sy));
    this.blob.rotation.z = pitch;
    this.body.position.y = bound + (p.sliding ? -0.12 : 0) - p.rest * 0.06;
    // Bumps: a wobble and a head shake.
    this.blob.rotation.x = Math.sin(time * 34) * 0.16 * p.bump;
    this.blob.position.x = 0;

    // Feet: front pair and back pair take turns; tucked up in the air, forward on a slide.
    this.feet.forEach((f, i) => {
      const home = f.userData.home as THREE.Vector3;
      const front = i < 2;
      const off = front ? 0 : Math.PI;
      const swing = Math.sin(ph + off + (i % 2) * 0.35);
      let x = home.x + swing * 0.13 * tiredK;
      let y = home.y + Math.max(0, Math.cos(ph + off)) * 0.09 * tiredK;
      if (air) {
        x = home.x + (front ? 0.08 : -0.08);
        y = home.y + 0.12;
      }
      if (p.sliding) {
        x = home.x + (front ? 0.18 : -0.12);
        y = 0.02;
      }
      if (p.rest > 0 && front) {
        x = x * (1 - p.rest) + (home.x - 0.02) * p.rest;
        y = y * (1 - p.rest) + 0.3 * p.rest;
      }
      f.position.set(x, y - this.body.position.y * 0.6, home.z);
    });

    // Ears flop back with speed and droop when tired.
    for (const [i, e] of this.ears.entries()) {
      const s = i === 0 ? -1 : 1;
      e.rotation.set(0.35 * s + Math.sin(ph * 2) * 0.05 * s, 0, 0.25 + Math.min(0.5, p.speed * 0.02) + p.rest * 0.4 + (air ? 0.3 : 0));
    }
    // Eyes close halfway when tired, squeeze shut on a bump.
    const lid = Math.max(p.rest * 0.65, p.bump * 0.8);
    for (const e of this.eyes) e.scale.y = Math.max(0.15, 1 - lid);

    // Sweat when out of puff or resting, stars right after a bump.
    this.sweat.visible = p.puffed || p.rest > 0.3;
    if (this.sweat.visible) {
      const k = (time * 1.4) % 1;
      this.sweat.position.set(0.35, 0.45 - k * 0.25, 0.33);
      (this.sweat.material as THREE.MeshPhongMaterial).opacity = 0.9 * (1 - k);
    }
    this.stars.visible = p.bump > 0.05;
    this.stars.rotation.y = time * 8;
    this.stars.position.y = 0.62 + Math.sin(time * 9) * 0.03;
  }
}
