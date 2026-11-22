/**
 * Менеджер транспорта: создание/удаление, шаги физики, общий инстанс-меш колёс,
 * пятна света фар на асфальте (инстансы), реальный прожектор для машины игрока.
 */
import * as THREE from 'three';
import { Vehicle } from './Vehicle';
import { wheelGeometry, type VehicleKind } from '../render/VehicleModels';
import { MaterialLib } from '../render/Materials';
import { poolTexture } from '../render/NeonAtlas';
import type { Game } from '../game/Game';

const MAX_WHEELS = 400;
const MAX_BEAMS = 80;

export class VehicleManager {
  readonly list: Vehicle[] = [];
  private wheels: THREE.InstancedMesh;
  private beams: THREE.InstancedMesh;
  readonly spot: THREE.SpotLight;
  private _m = new THREE.Matrix4();
  private _q = new THREE.Quaternion();
  private _v = new THREE.Vector3();

  constructor(private game: Game) {
    const wm = MaterialLib.std({ color: 0xffffff, vertexColors: true, roughness: 0.65, metalness: 0.35 });
    this.wheels = new THREE.InstancedMesh(wheelGeometry(), wm, MAX_WHEELS);
    this.wheels.castShadow = true;
    this.wheels.receiveShadow = true;
    this.wheels.frustumCulled = false;
    this.wheels.count = 0;
    game.engine.scene.add(this.wheels);
    // Пятна фар на дороге (ночью), аддитивные.
    const bg = new THREE.PlaneGeometry(1, 1);
    bg.rotateX(-Math.PI / 2);
    const bm = MaterialLib.unlit({ color: 0xfff2d8, map: poolTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
    this.beams = new THREE.InstancedMesh(bg, bm, MAX_BEAMS);
    this.beams.frustumCulled = false;
    this.beams.count = 0;
    game.engine.scene.add(this.beams);
    // Настоящий прожектор фар машины игрока (только Medium/High).
    this.spot = new THREE.SpotLight(0xfff0d0, 0, 60, 0.55, 0.6, 1.2);
    this.spot.castShadow = false;
    game.engine.scene.add(this.spot, this.spot.target);
    game.physics.preStep.push((dt) => { for (const v of this.list) v.preStep(dt); });
    game.physics.postStep.push((dt) => { for (const v of this.list) v.postStep(dt); });
  }

  spawn(kind: VehicleKind, pos: THREE.Vector3, yaw: number, opts: { kinematic?: boolean; paint?: number } = {}): Vehicle {
    const v = new Vehicle(this.game, kind, pos, yaw, opts);
    v.lastSeen = this.game.time;
    this.list.push(v);
    return v;
  }

  remove(v: Vehicle) {
    const i = this.list.indexOf(v);
    if (i < 0) return;
    this.list.splice(i, 1);
    v.dispose();
  }

  /** Ближайшая машина, в которую можно сесть. */
  nearestEnterable(p: THREE.Vector3, maxDist = 3.6): Vehicle | null {
    let best: Vehicle | null = null;
    let bd = maxDist;
    for (const v of this.list) {
      if (v.destroyed || v.playerDriving || v.inWater) continue;
      const vp = v.position(this._v);
      const reach = Math.max(v.spec.half[0], v.spec.half[2]) * 0.6 + maxDist * 0.6;
      const d = Math.hypot(vp.x - p.x, vp.z - p.z) - Math.max(0, reach - maxDist);
      if (Math.abs(vp.y - p.y) < 3 && d < bd) { bd = d; best = v; }
    }
    return best;
  }

  update(dt: number) {
    let wi = 0;
    let bi = 0;
    const night = this.game.engine.sky.night > 0.45;
    const cam = this.game.engine.camera.position;
    const shadowR = this.game.engine.preset.name === 'low' ? 30 : this.game.engine.preset.name === 'medium' ? 70 : 120;
    for (const v of this.list) {
      v.update(dt);
      const p = v.position(this._v);
      const d2 = p.distanceToSquared(cam);
      // Дальние машины не рисуются (кроме вертолётов — их видно издалека).
      v.root.visible = d2 < 230 * 230 || v.spec.type === 'heli' || v.playerDriving;
      v.bodyMesh.castShadow = d2 < shadowR * shadowR;
      if (v.root.visible && d2 < 230 * 230) {
        if (wi + 4 <= MAX_WHEELS) wi += v.writeWheels(this.wheels, wi);
        if (night && v.headlights && bi < MAX_BEAMS && v.spec.type !== 'heli' && v.spec.type !== 'boat') {
          // Пятно перед машиной, вытянутое вперёд.
          const f = v.forward();
          const yaw = Math.atan2(f.x, f.z);
          this._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
          const c = p.clone().addScaledVector(f, v.spec.half[2] + 6);
          c.y = this.game.world.surfaceHeight(c.x, c.z) + 0.06;
          this._m.compose(c, this._q, new THREE.Vector3(v.spec.type === 'moto' ? 4 : 7, 1, 13));
          this.beams.setMatrixAt(bi++, this._m);
        }
      }
    }
    this.wheels.count = wi;
    this.wheels.instanceMatrix.needsUpdate = true;
    this.beams.count = bi;
    this.beams.instanceMatrix.needsUpdate = true;
    (this.beams.material as THREE.MeshBasicMaterial).opacity = 0.55;
    // Прожектор машины игрока.
    const pv = this.game.player.vehicle;
    const useSpot = this.game.engine.preset.headlightSpot && pv && pv.headlights && pv.spec.type !== 'heli';
    if (useSpot && pv) {
      const f = pv.forward();
      const p = pv.position().addScaledVector(f, pv.spec.half[2]);
      p.y += pv.spec.colliderY;
      this.spot.position.copy(p);
      this.spot.target.position.copy(p).addScaledVector(f, 20).add(new THREE.Vector3(0, -2.5, 0));
      this.spot.intensity = 260;
    } else this.spot.intensity = 0;
  }

  /** Удаление дальних незанятых машин (трафик/обломки). */
  cleanup(center: THREE.Vector3, radius: number) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const v = this.list[i];
      if (v.persistent || v.playerDriving) continue;
      const d = v.position(this._v).distanceTo(center);
      if (d < radius) v.lastSeen = this.game.time;
      else if (this.game.time - v.lastSeen > 4) this.remove(v);
    }
  }

  get count() {
    return this.list.length;
  }
}
