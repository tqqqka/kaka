/**
 * Маркеры в мире (световые столбы, кольца, стрелки над целями) и метки миникарты,
 * плюс GPS-маршрут по графу дорог.
 */
import * as THREE from 'three';
import { MaterialLib } from '../render/Materials';
import type { Game } from './Game';
import type { Character } from '../entities/Character';
import type { Vehicle } from '../entities/Vehicle';

export type BlipKind = 'mission' | 'target' | 'enemy' | 'ally' | 'shop' | 'dest' | 'checkpoint' | 'package' | 'garage' | 'side';

export interface Blip {
  kind: BlipKind;
  label: string;
  color: string;
  icon: string;
  pos?: THREE.Vector3;
  char?: Character;
  vehicle?: Vehicle;
  /** Показывать на краю миникарты, если далеко. */
  edge: boolean;
}

const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true);
beamGeo.translate(0, 0.5, 0);
const ringGeo = new THREE.RingGeometry(0.85, 1, 32);
ringGeo.rotateX(-Math.PI / 2);
const arrowGeo = new THREE.ConeGeometry(0.35, 0.7, 4);
arrowGeo.rotateX(Math.PI);

function beamMat(color: THREE.ColorRepresentation) {
  const c = new THREE.Color(color);
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: c }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `uniform vec3 uColor; uniform float uTime; varying vec2 vUv;
      void main(){ float a = (1.0 - vUv.y) * (0.45 + 0.15 * sin(uTime * 3.0 + vUv.y * 10.0)); gl_FragColor = vec4(uColor * 2.0, a); }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  });
}

export class WorldMarker {
  readonly group = new THREE.Group();
  private beam: THREE.Mesh;
  private ring: THREE.Mesh;
  constructor(readonly pos: THREE.Vector3, readonly radius: number, color: THREE.ColorRepresentation, height = 18) {
    this.beam = new THREE.Mesh(beamGeo, beamMat(color));
    this.beam.scale.set(radius * 0.55, height, radius * 0.55);
    this.ring = new THREE.Mesh(ringGeo, MaterialLib.unlit({ color: new THREE.Color(color).multiplyScalar(2.5), transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    this.ring.scale.setScalar(radius);
    this.ring.position.y = 0.08;
    this.group.add(this.beam, this.ring);
    this.group.position.copy(pos);
  }
  update(t: number) {
    (this.beam.material as THREE.ShaderMaterial).uniforms.uTime.value = t;
    this.ring.scale.setScalar(this.radius * (1 + Math.sin(t * 3) * 0.06));
  }
  dispose() {
    this.group.removeFromParent();
    (this.beam.material as THREE.Material).dispose();
    (this.ring.material as THREE.Material).dispose();
  }
}

/** Стрелка над головой цели (враг, машина-цель, напарник). */
export class TargetArrow {
  readonly mesh: THREE.Mesh;
  constructor(color: THREE.ColorRepresentation, readonly char?: Character, readonly vehicle?: Vehicle) {
    this.mesh = new THREE.Mesh(arrowGeo, MaterialLib.unlit({ color: new THREE.Color(color).multiplyScalar(2) }));
  }
  update(t: number) {
    let p: THREE.Vector3 | null = null;
    if (this.vehicle) p = this.vehicle.position().add(new THREE.Vector3(0, this.vehicle.spec.colliderY + this.vehicle.spec.half[1] + 1.6, 0));
    else if (this.char) p = this.char.pos.clone().add(new THREE.Vector3(0, 2.3, 0));
    if (!p) return;
    this.mesh.position.copy(p).y += Math.sin(t * 4) * 0.15;
    this.mesh.rotation.y = t * 2;
    this.mesh.visible = this.char ? this.char.alive && this.char.visible : !this.vehicle?.destroyed;
  }
}

export class Markers {
  readonly blips = new Set<Blip>();
  private world = new Set<WorldMarker>();
  private arrows = new Set<TargetArrow>();
  /** Точка назначения GPS. */
  gpsTarget: THREE.Vector3 | null = null;
  /** Ручная метка игрока на карте. */
  waypoint: THREE.Vector3 | null = null;
  route: number[] = [];
  private routeT = 0;

  constructor(private game: Game) {}

  addBlip(b: Partial<Blip> & { kind: BlipKind }): Blip {
    const blip: Blip = { label: '', color: '#ffd23b', icon: '', edge: true, ...b };
    this.blips.add(blip);
    return blip;
  }
  removeBlip(b: Blip | null | undefined) {
    if (b) this.blips.delete(b);
  }

  addMarker(pos: THREE.Vector3, radius: number, color: THREE.ColorRepresentation, height = 18): WorldMarker {
    const m = new WorldMarker(pos, radius, color, height);
    this.game.engine.scene.add(m.group);
    this.world.add(m);
    return m;
  }
  removeMarker(m: WorldMarker | null | undefined) {
    if (!m) return;
    m.dispose();
    this.world.delete(m);
  }

  addArrow(color: THREE.ColorRepresentation, char?: Character, vehicle?: Vehicle): TargetArrow {
    const a = new TargetArrow(color, char, vehicle);
    this.game.engine.scene.add(a.mesh);
    this.arrows.add(a);
    return a;
  }
  removeArrow(a: TargetArrow | null | undefined) {
    if (!a) return;
    a.mesh.removeFromParent();
    this.arrows.delete(a);
  }

  update(dt: number) {
    const t = this.game.time;
    for (const m of this.world) m.update(t);
    for (const a of this.arrows) a.update(t);
    // GPS: пересчёт маршрута раз в секунду.
    const target = this.gpsTarget ?? this.waypoint;
    this.routeT -= dt;
    if (target && this.routeT <= 0) {
      this.routeT = 1;
      const graph = this.game.world.graph;
      const p = this.game.player.vehicle ? this.game.player.vehicle.position() : this.game.player.char.pos;
      const a = graph.nearestNode(p.x, p.z), b = graph.nearestNode(target.x, target.z);
      const path = graph.findPath(a.id, b.id);
      this.route = graph.pathPolyline(path);
      this.route.unshift(p.x, p.z);
      this.route.push(target.x, target.z);
    } else if (!target) this.route = [];
    if (this.waypoint && this.game.player.char.pos.distanceTo(this.waypoint) < 15) {
      this.waypoint = null;
      this.game.hud.toast('Вы на месте');
    }
  }

  clearMission() {
    for (const b of [...this.blips]) if (b.kind !== 'shop' && b.kind !== 'garage' && b.kind !== 'side' && b.kind !== 'mission') this.blips.delete(b);
    for (const m of [...this.world]) this.removeMarker(m);
    for (const a of [...this.arrows]) this.removeArrow(a);
    this.gpsTarget = null;
  }

  blipPos(b: Blip): THREE.Vector3 | null {
    if (b.char) return b.char.alive ? b.char.pos : null;
    if (b.vehicle) return b.vehicle.destroyed ? null : b.vehicle.position();
    return b.pos ?? null;
  }
}
