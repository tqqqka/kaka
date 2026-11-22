/**
 * Простая шина событий (выстрелы, смерти, преступления, миссии).
 */
import type * as THREE from 'three';
import type { Character } from '../entities/Character';
import type { Vehicle } from '../entities/Vehicle';

export interface GameEvents {
  gunshot: { pos: THREE.Vector3; shooter: Character };
  explosion: { pos: THREE.Vector3; radius: number; source: Character | null };
  death: { victim: Character; killer: Character | null };
  pedHit: { victim: Character; vehicle: Vehicle; speed: number };
  vehicleDestroyed: { vehicle: Vehicle; by: Character | null };
  vehicleStolen: { vehicle: Vehicle; thief: Character };
  vehicleDamaged: { vehicle: Vehicle; by: Character | null; amount: number };
  money: { amount: number; reason: string };
  notify: { text: string; kind?: 'info' | 'good' | 'bad' };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private map = new Map<keyof GameEvents, Set<Handler<never>>>();

  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.map.get(type);
    if (!set) { set = new Set(); this.map.set(type, set); }
    set.add(fn as Handler<never>);
    return () => set!.delete(fn as Handler<never>);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]) {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of [...set]) (fn as Handler<GameEvents[K]>)(payload);
  }
}
