/**
 * Накопитель процедурной геометрии. Позволяет быстро собирать тысячи ящиков/призм
 * в один BufferGeometry (один draw call на чанк) с пользовательским атрибутом
 * (aFacade для зданий, aRoad для дорог, aPart для машин).
 */
import * as THREE from 'three';

const _v = new THREE.Vector3();

export class GeomBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  attr: number[] = [];
  idx: number[] = [];
  /** Текущие значения «кисти». */
  color: [number, number, number] = [1, 1, 1];
  attrVal: number[];

  constructor(readonly attrName: string | null = null, readonly attrSize = 4) {
    this.attrVal = new Array(attrSize).fill(0);
  }

  get vertexCount() {
    return this.pos.length / 3;
  }

  setColor(c: THREE.Color | number) {
    if (typeof c === 'number') {
      const cc = new THREE.Color(c);
      this.color = [cc.r, cc.g, cc.b];
    } else this.color = [c.r, c.g, c.b];
    return this;
  }

  setAttr(...v: number[]) {
    for (let i = 0; i < this.attrSize; i++) this.attrVal[i] = v[i] ?? 0;
    return this;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(this.color[0], this.color[1], this.color[2]);
    if (this.attrName) for (let i = 0; i < this.attrSize; i++) this.attr.push(this.attrVal[i]);
    return this.vertexCount - 1;
  }

  /** Четырёхугольник a-b-c-d (против часовой стрелки при взгляде со стороны нормали). */
  quad(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
    u0: number, v0: number, u1: number, v1: number,
  ) {
    const i = this.vertex(ax, ay, az, nx, ny, nz, u0, v0);
    this.vertex(bx, by, bz, nx, ny, nz, u1, v0);
    this.vertex(cx, cy, cz, nx, ny, nz, u1, v1);
    this.vertex(dx, dy, dz, nx, ny, nz, u0, v1);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  /** Горизонтальный прямоугольник (верхняя грань), uv = мировые xz. */
  hRect(x0: number, z0: number, x1: number, z1: number, y: number, uvScale = 1, uvLocal?: [number, number, number, number]) {
    const [u0, v0, u1, v1] = uvLocal ?? [x0 * uvScale, z0 * uvScale, x1 * uvScale, z1 * uvScale];
    const i = this.vertex(x0, y, z1, 0, 1, 0, u0, v1);
    this.vertex(x1, y, z1, 0, 1, 0, u1, v1);
    this.vertex(x1, y, z0, 0, 1, 0, u1, v0);
    this.vertex(x0, y, z0, 0, 1, 0, u0, v0);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  /**
   * Ящик со стенами, у которых uv в метрах: u — вдоль стены (непрерывно по периметру),
   * v — абсолютная высота. Это выравнивает окна между ярусами здания.
   */
  box(cx: number, y0: number, cz: number, w: number, h: number, d: number, rotY = 0, top = true, bottom = false, uOffset = 0) {
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const hw = w / 2, hd = d / 2;
    // Углы в порядке обхода против часовой (вид сверху).
    const corners: [number, number][] = [[-hw, hd], [hw, hd], [hw, -hd], [-hw, -hd]];
    const P = corners.map(([x, z]) => [cx + x * c + z * s, cz - x * s + z * c]);
    let u = uOffset;
    for (let k = 0; k < 4; k++) {
      const a = P[k], b = P[(k + 1) % 4];
      const ex = b[0] - a[0], ez = b[1] - a[1];
      const len = Math.hypot(ex, ez);
      const nx = ez / len, nz = -ex / len;
      this.quad(a[0], y0, a[1], b[0], y0, b[1], b[0], y0 + h, b[1], a[0], y0 + h, a[1], nx, 0, nz, u, y0, u + len, y0 + h);
      u += len;
    }
    if (top) {
      const i = this.vertex(P[0][0], y0 + h, P[0][1], 0, 1, 0, P[0][0], P[0][1]);
      this.vertex(P[1][0], y0 + h, P[1][1], 0, 1, 0, P[1][0], P[1][1]);
      this.vertex(P[2][0], y0 + h, P[2][1], 0, 1, 0, P[2][0], P[2][1]);
      this.vertex(P[3][0], y0 + h, P[3][1], 0, 1, 0, P[3][0], P[3][1]);
      this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
    }
    if (bottom) {
      const i = this.vertex(P[3][0], y0, P[3][1], 0, -1, 0, 0, 0);
      this.vertex(P[2][0], y0, P[2][1], 0, -1, 0, 1, 0);
      this.vertex(P[1][0], y0, P[1][1], 0, -1, 0, 1, 1);
      this.vertex(P[0][0], y0, P[0][1], 0, -1, 0, 0, 1);
      this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
    }
  }

  /** Правильная призма (цилиндр/восьмигранник) с плоским верхом. taper — сужение кверху (0..1). */
  prism(cx: number, y0: number, cz: number, r: number, sides: number, h: number, rot = 0, top = true, taper = 0) {
    const r2 = r * (1 - taper);
    let u = 0;
    const seg = 2 * Math.PI / sides;
    for (let k = 0; k < sides; k++) {
      const a0 = rot - k * seg, a1 = rot - (k + 1) * seg;
      const ax = cx + Math.cos(a0) * r, az = cz + Math.sin(a0) * r;
      const bx = cx + Math.cos(a1) * r, bz = cz + Math.sin(a1) * r;
      const tax = cx + Math.cos(a0) * r2, taz = cz + Math.sin(a0) * r2;
      const tbx = cx + Math.cos(a1) * r2, tbz = cz + Math.sin(a1) * r2;
      const len = Math.hypot(bx - ax, bz - az);
      const am = (a0 + a1) / 2;
      _v.set(Math.cos(am), taper * r / h, Math.sin(am)).normalize();
      this.quad(ax, y0, az, bx, y0, bz, tbx, y0 + h, tbz, tax, y0 + h, taz, _v.x, _v.y, _v.z, u, y0, u + len, y0 + h);
      u += len;
    }
    if (top) {
      const ci = this.vertex(cx, y0 + h, cz, 0, 1, 0, cx, cz);
      for (let k = 0; k <= sides; k++) {
        const a = rot - k * seg;
        this.vertex(cx + Math.cos(a) * r2, y0 + h, cz + Math.sin(a) * r2, 0, 1, 0, cx + Math.cos(a) * r2, cz + Math.sin(a) * r2);
      }
      for (let k = 0; k < sides; k++) this.idx.push(ci, ci + 1 + k + 1, ci + 1 + k);
    }
  }

  /** Пирамида/шпиль с вершиной над центром. */
  pyramid(cx: number, y0: number, cz: number, w: number, d: number, h: number, rotY = 0) {
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const hw = w / 2, hd = d / 2;
    const corners: [number, number][] = [[-hw, hd], [hw, hd], [hw, -hd], [-hw, -hd]];
    const P = corners.map(([x, z]) => [cx + x * c + z * s, cz - x * s + z * c]);
    for (let k = 0; k < 4; k++) {
      const a = P[k], b = P[(k + 1) % 4];
      const mx = (a[0] + b[0]) / 2 - cx, mz = (a[1] + b[1]) / 2 - cz;
      const ml = Math.hypot(mx, mz) || 1;
      _v.set(mx / ml * h, ml, mz / ml * h).normalize();
      const i = this.vertex(a[0], y0, a[1], _v.x, _v.y, _v.z, a[0], a[1]);
      this.vertex(b[0], y0, b[1], _v.x, _v.y, _v.z, b[0], b[1]);
      this.vertex(cx, y0 + h, cz, _v.x, _v.y, _v.z, cx, cz);
      this.idx.push(i, i + 1, i + 2);
    }
  }

  /** Двускатная крыша вдоль оси X локального ящика. */
  gable(cx: number, y0: number, cz: number, w: number, d: number, h: number, rotY = 0, overhang = 0.4) {
    const c = Math.cos(rotY), s = Math.sin(rotY);
    const hw = w / 2 + overhang, hd = d / 2 + overhang;
    const tr = (x: number, z: number): [number, number] => [cx + x * c + z * s, cz - x * s + z * c];
    const A = tr(-hw, hd), B = tr(hw, hd), C = tr(hw, -hd), D = tr(-hw, -hd);
    const E = tr(-hw, 0), F = tr(hw, 0);
    const slope = Math.atan2(h, hd);
    // Южный скат (+z локально).
    let ny = Math.cos(slope), nl = Math.sin(slope);
    let nx = 0 * c + nl * s, nz = -0 * s + nl * c;
    this.quad(A[0], y0, A[1], B[0], y0, B[1], F[0], y0 + h, F[1], E[0], y0 + h, E[1], nx, ny, nz, 0, 0, w, Math.hypot(h, hd));
    nx = -nl * s; nz = -nl * c;
    this.quad(C[0], y0, C[1], D[0], y0, D[1], E[0], y0 + h, E[1], F[0], y0 + h, F[1], nx, ny, nz, 0, 0, w, Math.hypot(h, hd));
    // Фронтоны.
    const g1 = tr(-w / 2, d / 2), g2 = tr(-w / 2, -d / 2), g3 = tr(-w / 2, 0);
    const g4 = tr(w / 2, -d / 2), g5 = tr(w / 2, d / 2), g6 = tr(w / 2, 0);
    let i = this.vertex(g2[0], y0, g2[1], -c, 0, s, 0, y0);
    this.vertex(g1[0], y0, g1[1], -c, 0, s, d, y0);
    this.vertex(g3[0], y0 + h, g3[1], -c, 0, s, d / 2, y0 + h);
    this.idx.push(i, i + 1, i + 2);
    i = this.vertex(g5[0], y0, g5[1], c, 0, -s, 0, y0);
    this.vertex(g4[0], y0, g4[1], c, 0, -s, d, y0);
    this.vertex(g6[0], y0 + h, g6[1], c, 0, -s, d / 2, y0 + h);
    this.idx.push(i, i + 1, i + 2);
    void ny;
  }

  /** Добавить произвольную геометрию three.js с трансформом (для пропсов и машин). */
  addGeometry(g: THREE.BufferGeometry, m: THREE.Matrix4) {
    const gi = g.index ? g : g;
    const p = gi.getAttribute('position');
    const n = gi.getAttribute('normal');
    const t = gi.getAttribute('uv');
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const base = this.vertexCount;
    const vn = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(m);
      if (n) vn.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      else vn.set(0, 1, 0);
      this.vertex(_v.x, _v.y, _v.z, vn.x, vn.y, vn.z, t ? t.getX(i) : 0, t ? t.getY(i) : 0);
    }
    if (gi.index) {
      const ix = gi.index;
      for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
    } else {
      for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.attrName) g.setAttribute(this.attrName, new THREE.Float32BufferAttribute(this.attr, this.attrSize));
    const vc = this.vertexCount;
    g.setIndex(vc > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  isEmpty() {
    return this.idx.length === 0;
  }
}
