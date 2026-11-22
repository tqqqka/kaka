/**
 * Обёртка над Rapier (WASM): фиксированный шаг 60 Гц, группы столкновений,
 * статические коллайдеры мира, лучевые запросы.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { StaticCollider } from '../world/World';
import type { BoxCollider } from '../world/ChunkBuilder';

export { RAPIER };

/** Группы столкновений (битовые маски). */
export const G_STATIC = 1;
export const G_VEHICLE = 2;
export const G_CHAR = 4;
export const G_DEBRIS = 8;
export const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  dist: number;
  collider: RAPIER.Collider;
  owner: unknown;
}

export class Physics {
  static async init() {
    await RAPIER.init();
  }

  readonly world: RAPIER.World;
  readonly fixedDt = 1 / 60;
  private acc = 0;
  /** Коллайдер → владелец (машина и т.п.) для попаданий. */
  readonly owners = new Map<number, unknown>();
  private propColliders = new Map<BoxCollider, RAPIER.Collider>();
  /** Вызывается перед каждым фиксированным подшагом (силы машин и т.п.). */
  readonly preStep: ((dt: number) => void)[] = [];
  readonly postStep: ((dt: number) => void)[] = [];
  steps = 0;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = this.fixedDt;
    this.world.numSolverIterations = 4;
  }

  /** Статика мира: создаётся один раз при загрузке. */
  addStatic(list: StaticCollider[]) {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const q = new THREE.Quaternion();
    for (const c of list) {
      let desc: RAPIER.ColliderDesc;
      if (c.kind === 'cyl') desc = RAPIER.ColliderDesc.cylinder(c.hy, c.r ?? c.hx);
      else desc = RAPIER.ColliderDesc.cuboid(Math.max(0.05, c.hx), Math.max(0.05, c.hy), Math.max(0.05, c.hz));
      desc.setTranslation(c.x, c.y, c.z);
      if (c.rot) {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.rot);
        desc.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
      }
      desc.setCollisionGroups(groups(G_STATIC, 0xffff));
      desc.setFriction(0.9);
      this.world.createCollider(desc, body);
    }
  }

  addTrimesh(verts: Float32Array, idx: Uint32Array) {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const desc = RAPIER.ColliderDesc.trimesh(verts, idx).setCollisionGroups(groups(G_STATIC, 0xffff)).setFriction(0.9);
    this.world.createCollider(desc, body);
  }

  /** Коллайдеры пропсов чанков (контейнеры, краны) — добавляются/удаляются при стриминге. */
  updateProps(add: BoxCollider[] | null, remove: BoxCollider[] | null) {
    if (remove) for (const b of remove) {
      const c = this.propColliders.get(b);
      if (c) { this.world.removeCollider(c, false); this.propColliders.delete(b); }
    }
    if (add) {
      const q = new THREE.Quaternion();
      for (const b of add) {
        const desc = RAPIER.ColliderDesc.cuboid(b.hx, b.hy, b.hz).setTranslation(b.x, b.y, b.z).setCollisionGroups(groups(G_STATIC, 0xffff));
        if (b.rot) { q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.rot); desc.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }); }
        this.propColliders.set(b, this.world.createCollider(desc));
      }
    }
  }

  /** Фиксированный шаг с накоплением. Возвращает число подшагов. */
  step(dt: number): number {
    this.acc = Math.min(this.acc + dt, this.fixedDt * 4);
    let n = 0;
    while (this.acc >= this.fixedDt) {
      for (const f of this.preStep) f(this.fixedDt);
      this.world.step();
      for (const f of this.postStep) f(this.fixedDt);
      this.acc -= this.fixedDt;
      n++;
    }
    this.steps += n;
    return n;
  }

  private _ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  /** Луч против мира. mask — какие группы учитывать. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, mask = 0xffff, excludeBody?: RAPIER.RigidBody): RayHit | null {
    this._ray.origin = { x: origin.x, y: origin.y, z: origin.z };
    this._ray.dir = { x: dir.x, y: dir.y, z: dir.z };
    const hit = this.world.castRayAndGetNormal(this._ray, maxDist, true, undefined, groups(0xffff, mask), undefined, excludeBody);
    if (!hit) return null;
    const t = hit.timeOfImpact;
    return {
      point: new THREE.Vector3(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      dist: t,
      collider: hit.collider,
      owner: this.owners.get(hit.collider.handle),
    };
  }

  /** Есть ли прямая видимость между точками (по статике). */
  lineOfSight(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const d = new THREE.Vector3().subVectors(b, a);
    const L = d.length();
    if (L < 0.01) return true;
    d.divideScalar(L);
    return this.raycast(a, d, L - 0.2, G_STATIC) === null;
  }
}
