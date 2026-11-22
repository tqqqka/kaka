/**
 * Система частиц на инстансах: дым, огонь, искры, кровь, пыль, брызги, вспышки выстрелов.
 * Два пула (аддитивный и обычный), по одному draw call каждый. Billboard в вершинном шейдере.
 */
import * as THREE from 'three';

interface P {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; max: number;
  size0: number; size1: number;
  r: number; g: number; b: number;
  a0: number; a1: number;
  drag: number; grav: number;
  shape: number;
  rot: number;
}

class Pool {
  readonly mesh: THREE.InstancedMesh;
  private ps: P[] = [];
  private aCol: THREE.InstancedBufferAttribute;
  private aPos: THREE.InstancedBufferAttribute;
  private aMisc: THREE.InstancedBufferAttribute;

  constructor(readonly cap: number, additive: boolean) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); // xyz + size
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); // rgb + alpha
    this.aMisc = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2); // форма, поворот
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aCol.setUsage(THREE.DynamicDrawUsage);
    this.aMisc.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iCol', this.aCol);
    geo.setAttribute('iMisc', this.aMisc);
    const mat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec4 iPos; attribute vec4 iCol; attribute vec2 iMisc;
        varying vec4 vCol; varying vec2 vUv; varying float vShape;
        void main() {
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          float c = cos(iMisc.y), s = sin(iMisc.y);
          vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
          if (iMisc.x > 1.5 && iMisc.x < 2.5) p.y *= 4.0; // искры вытянуты
          vec3 wp = iPos.xyz + (right * p.x + up * p.y) * iPos.w;
          vCol = iCol; vUv = uv; vShape = iMisc.x;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vCol; varying vec2 vUv; varying float vShape;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
        void main() {
          vec2 c = vUv - 0.5; float d = length(c) * 2.0;
          float a;
          if (vShape < 0.5) a = smoothstep(1.0, 0.0, d);                      // мягкий диск
          else if (vShape < 1.5) a = smoothstep(1.0, 0.2, d) * (0.75 + 0.25 * h(floor(vUv * 6.0))); // дым
          else if (vShape < 2.5) a = smoothstep(1.0, 0.3, d);                // искра
          else a = smoothstep(1.0, 0.75, d);                                  // капля
          if (a * vCol.a < 0.004) discard;
          gl_FragColor = vec4(vCol.rgb, a * vCol.a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 20 : 10;
  }

  emit(p: P) {
    if (this.ps.length >= this.cap) this.ps.shift();
    this.ps.push(p);
  }

  update(dt: number) {
    const ps = this.ps;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.life += dt;
      if (p.life >= p.max) continue;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vy = p.vy * k - p.grav * dt; p.vz *= k;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      ps[w++] = p;
    }
    ps.length = w;
    const pos = this.aPos.array as Float32Array, col = this.aCol.array as Float32Array, misc = this.aMisc.array as Float32Array;
    for (let i = 0; i < w; i++) {
      const p = ps[i];
      const t = p.life / p.max;
      pos[i * 4] = p.x; pos[i * 4 + 1] = p.y; pos[i * 4 + 2] = p.z;
      pos[i * 4 + 3] = p.size0 + (p.size1 - p.size0) * t;
      col[i * 4] = p.r; col[i * 4 + 1] = p.g; col[i * 4 + 2] = p.b;
      col[i * 4 + 3] = p.a0 + (p.a1 - p.a0) * t;
      misc[i * 2] = p.shape;
      misc[i * 2 + 1] = p.shape === 2 ? Math.atan2(p.vx, p.vy) : p.rot + p.life * 0.5;
    }
    this.mesh.count = w;
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aMisc.needsUpdate = true;
  }

  get count() { return this.ps.length; }
}

const R = () => Math.random() * 2 - 1;

export class Particles {
  readonly add: Pool;
  readonly norm: Pool;
  /** Множитель количества частиц по пресету качества. */
  density = 1;

  constructor(scene: THREE.Scene) {
    this.add = new Pool(1200, true);
    this.norm = new Pool(1200, false);
    scene.add(this.add.mesh, this.norm.mesh);
  }

  update(dt: number) {
    this.add.update(dt);
    this.norm.update(dt);
  }

  private base(x: number, y: number, z: number): P {
    return { x, y, z, vx: 0, vy: 0, vz: 0, life: 0, max: 1, size0: 0.2, size1: 0.2, r: 1, g: 1, b: 1, a0: 1, a1: 0, drag: 0, grav: 0, shape: 0, rot: Math.random() * 6.28 };
  }

  private n(k: number) {
    return Math.max(1, Math.round(k * this.density));
  }

  muzzle(pos: THREE.Vector3, dir: THREE.Vector3) {
    const p = this.base(pos.x, pos.y, pos.z);
    Object.assign(p, { max: 0.06, size0: 0.55, size1: 0.3, r: 6, g: 3.8, b: 1.6, a0: 1, a1: 0 });
    this.add.emit(p);
    for (let i = 0; i < this.n(3); i++) {
      const q = this.base(pos.x + dir.x * 0.2, pos.y + dir.y * 0.2, pos.z + dir.z * 0.2);
      Object.assign(q, { vx: dir.x * 8 + R(), vy: dir.y * 8 + R(), vz: dir.z * 8 + R(), max: 0.05, size0: 0.25, size1: 0.1, r: 5, g: 3, b: 1, shape: 0 });
      this.add.emit(q);
    }
    const s = this.base(pos.x, pos.y, pos.z);
    Object.assign(s, { vx: dir.x + R() * 0.3, vy: 0.5, vz: dir.z + R() * 0.3, max: 0.8, size0: 0.2, size1: 0.8, r: 0.6, g: 0.6, b: 0.6, a0: 0.35, a1: 0, drag: 2, shape: 1 });
    this.norm.emit(s);
  }

  sparks(pos: THREE.Vector3, normal: THREE.Vector3, count = 6) {
    for (let i = 0; i < this.n(count); i++) {
      const p = this.base(pos.x, pos.y, pos.z);
      const sp = 3 + Math.random() * 5;
      Object.assign(p, {
        vx: (normal.x + R() * 0.7) * sp, vy: (normal.y + R() * 0.7 + 0.3) * sp, vz: (normal.z + R() * 0.7) * sp,
        max: 0.25 + Math.random() * 0.25, size0: 0.05, size1: 0.02, r: 5, g: 3, b: 1.2, a0: 1, a1: 0, grav: 9, shape: 2,
      });
      this.add.emit(p);
    }
    const d = this.base(pos.x, pos.y, pos.z);
    Object.assign(d, { vx: normal.x, vy: normal.y + 0.3, vz: normal.z, max: 0.6, size0: 0.15, size1: 0.6, r: 0.55, g: 0.52, b: 0.48, a0: 0.5, a1: 0, drag: 3, shape: 1 });
    this.norm.emit(d);
  }

  blood(pos: THREE.Vector3, dir: THREE.Vector3) {
    for (let i = 0; i < this.n(8); i++) {
      const p = this.base(pos.x, pos.y, pos.z);
      const sp = 1 + Math.random() * 3;
      Object.assign(p, { vx: dir.x * sp + R(), vy: dir.y * sp + Math.random() * 2, vz: dir.z * sp + R(), max: 0.5, size0: 0.08, size1: 0.05, r: 0.35, g: 0.01, b: 0.01, a0: 0.95, a1: 0.6, grav: 9.8, shape: 3 });
      this.norm.emit(p);
    }
  }

  smoke(pos: THREE.Vector3, dark: number, size = 1, vy = 1.6) {
    const p = this.base(pos.x + R() * 0.3, pos.y, pos.z + R() * 0.3);
    const c = 0.6 - dark * 0.52;
    Object.assign(p, { vx: R() * 0.4, vy: vy + Math.random(), vz: R() * 0.4, max: 2.2 + Math.random(), size0: 0.5 * size, size1: 2.6 * size, r: c, g: c, b: c * 1.02, a0: 0.55, a1: 0, drag: 0.6, shape: 1 });
    this.norm.emit(p);
  }

  fire(pos: THREE.Vector3, size = 1) {
    const p = this.base(pos.x + R() * 0.4 * size, pos.y, pos.z + R() * 0.4 * size);
    Object.assign(p, { vx: R() * 0.3, vy: 2 + Math.random() * 1.5, vz: R() * 0.3, max: 0.45 + Math.random() * 0.3, size0: 0.9 * size, size1: 0.2 * size, r: 4, g: 1.6, b: 0.35, a0: 0.9, a1: 0, drag: 1, shape: 1 });
    this.add.emit(p);
  }

  explosion(pos: THREE.Vector3, scale = 1) {
    const flash = this.base(pos.x, pos.y + 0.5, pos.z);
    Object.assign(flash, { max: 0.18, size0: 6 * scale, size1: 10 * scale, r: 12, g: 7, b: 3, a0: 1, a1: 0 });
    this.add.emit(flash);
    for (let i = 0; i < this.n(26); i++) {
      const p = this.base(pos.x, pos.y + 0.5, pos.z);
      const sp = (2 + Math.random() * 7) * scale;
      Object.assign(p, { vx: R() * sp, vy: Math.random() * sp * 1.2, vz: R() * sp, max: 0.5 + Math.random() * 0.6, size0: 2.2 * scale, size1: 0.6 * scale, r: 5, g: 2.2, b: 0.5, a0: 1, a1: 0, drag: 2.5, shape: 1 });
      this.add.emit(p);
    }
    for (let i = 0; i < this.n(22); i++) {
      const p = this.base(pos.x, pos.y + 1, pos.z);
      const sp = (1 + Math.random() * 4) * scale;
      Object.assign(p, { vx: R() * sp, vy: 1 + Math.random() * sp, vz: R() * sp, max: 3 + Math.random() * 2, size0: 2 * scale, size1: 7 * scale, r: 0.12, g: 0.11, b: 0.1, a0: 0.75, a1: 0, drag: 1.2, shape: 1 });
      this.norm.emit(p);
    }
    this.sparks(pos, new THREE.Vector3(0, 1, 0), 24);
  }

  dust(pos: THREE.Vector3, amount = 1, color = 0.55) {
    const p = this.base(pos.x + R() * 0.3, pos.y + 0.1, pos.z + R() * 0.3);
    Object.assign(p, { vx: R() * 0.8, vy: 0.4 + Math.random() * 0.5, vz: R() * 0.8, max: 1.2, size0: 0.4 * amount, size1: 1.8 * amount, r: color, g: color * 0.95, b: color * 0.88, a0: 0.35, a1: 0, drag: 1.5, shape: 1 });
    this.norm.emit(p);
  }

  splash(pos: THREE.Vector3, amount = 1) {
    for (let i = 0; i < this.n(10 * amount); i++) {
      const p = this.base(pos.x + R() * amount, pos.y, pos.z + R() * amount);
      Object.assign(p, { vx: R() * 2, vy: 2 + Math.random() * 3 * amount, vz: R() * 2, max: 0.8, size0: 0.25, size1: 0.5, r: 0.8, g: 0.88, b: 0.95, a0: 0.7, a1: 0, grav: 9.8, shape: 3 });
      this.norm.emit(p);
    }
  }

  /** Линия трассера пули (короткоживущие точки вдоль траектории). */
  tracer(a: THREE.Vector3, b: THREE.Vector3) {
    const d = b.clone().sub(a);
    const L = d.length();
    d.divideScalar(L);
    const p = this.base(a.x + d.x * 2, a.y + d.y * 2, a.z + d.z * 2);
    const sp = Math.min(400, L * 12);
    Object.assign(p, { vx: d.x * sp, vy: d.y * sp, vz: d.z * sp, max: Math.min(0.09, L / sp), size0: 0.06, size1: 0.04, r: 6, g: 4.5, b: 2, a0: 1, a1: 0.5, shape: 2 });
    this.add.emit(p);
  }

  get stats() {
    return this.add.count + this.norm.count;
  }
}
