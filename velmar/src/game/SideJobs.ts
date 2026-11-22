/**
 * Подработка (повторяемые задания) и тайники.
 *  - Такси «Вельмар-Экспресс»: три пассажира подряд, оплата за расстояние и скорость.
 *  - Уличная гонка у Площади Основателей: взнос $200, приз $1200.
 *  - Ночной патруль: на полицейской машине уничтожить машину преступника.
 *  - Заказ Нины: пригнать машину нужной модели в целости.
 *  - 20 тайников по городу: $250 за каждый, за все — бонус $10 000 и бронежилет.
 */
import * as THREE from 'three';
import { S, type MissionDef, type Step } from './Missions';
import type { Character } from '../entities/Character';
import { lineX, lineZ, type CityLayout } from '../world/CityLayout';
import type { Vehicle } from '../entities/Vehicle';
import type { Game } from './Game';
import { RNG } from '../core/MathUtil';
import { SPECS, type VehicleKind } from '../render/VehicleModels';
import { MaterialLib } from '../render/Materials';
import { randomOutfit } from '../entities/CharacterModel';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const node = (i: number, j: number, dx = 0, dz = 0) => V(lineX(i) + dx, 0, lineZ(j) + dz);

/** Случайная точка на тротуаре в радиусе от центра. */
function sidewalkPoint(L: CityLayout, center: THREE.Vector3, rMin: number, rMax: number): THREE.Vector3 {
  for (let k = 0; k < 40; k++) {
    const a = Math.random() * Math.PI * 2, r = rMin + Math.random() * (rMax - rMin);
    const x = center.x + Math.cos(a) * r, z = center.z + Math.sin(a) * r;
    const b = L.blockAt(x, z);
    if (!b || b.district === 'port') continue;
    // Ближайшая точка края квартала (тротуар у дороги).
    const cands = [V(x, 0.15, b.z0 + 1.2), V(x, 0.15, b.z1 - 1.2), V(b.x0 + 1.2, 0.15, z), V(b.x1 - 1.2, 0.15, z)];
    cands.sort((p, q) => p.distanceTo(V(x, 0, z)) - q.distanceTo(V(x, 0, z)));
    const p = cands[0];
    p.x = Math.min(b.x1 - 1.2, Math.max(b.x0 + 1.2, p.x));
    p.z = Math.min(b.z1 - 1.2, Math.max(b.z0 + 1.2, p.z));
    return p;
  }
  return center.clone();
}

export function sideJobs(L: CityLayout): MissionDef[] {
  const plaza = L.specialBlock('plaza');
  // ---------------------------------------------------------------- такси
  const taxi: MissionDef = {
    id: 'taxi', title: 'Такси «Вельмар-Экспресс»', giver: 'T', story: false, reward: 0,
    desc: 'Развезите трёх пассажиров. Быстрее — больше чаевых.',
    where: () => V(plaza.x0 - 2, 0, plaza.z1 - 10),
    build: (m) => {
      const steps: Step[] = [
        S.run((r) => {
          const s = r.def.where();
          const v = r.vehicle('taxi', V(s.x - 4.5, 0.5, s.z), Math.PI);
          r.data.taxi = v;
          r.data.earned = 0;
          r.guards.push(() => (v.destroyed ? 'Такси разбито' : null));
        }),
        S.enterVehicle(() => m.data.taxi as Vehicle, 'Садитесь в <b>такси</b>'),
      ];
      for (let k = 0; k < 3; k++) {
        steps.push(
          S.run((r) => {
            const p = r.game.player.vehicle?.position() ?? r.game.player.char.pos;
            const pick = sidewalkPoint(L, p, 120, 260);
            r.data.pick = pick;
            const c = r.game.spawnCharacter(randomOutfit(Math.random), 'civ', pick);
            r.game.peds?.makeScripted(c);
            c.model.anim.handsUp = true;
            r.chars.push(c);
            r.data.client = c;
          }),
          S.goTo(() => (m.data.pick as THREE.Vector3).clone(), { r: 5, text: `Заберите пассажира <b>${k + 1}/3</b>`, vehicle: () => m.data.taxi as Vehicle }),
          S.run((r) => {
            const c = r.data.client as Character;
            c.visible = false; c.vehicle = r.data.taxi as Vehicle; c.model.anim.handsUp = false;
            const from = r.game.player.vehicle!.position();
            const dest = sidewalkPoint(L, from, 350, 800);
            r.data.dest = dest;
            const dist = from.distanceTo(dest);
            r.data.fare = Math.round(40 + dist * 0.18);
            r.data.time = Math.round(25 + dist / 11);
            const lines = ['На набережную, и побыстрее!', 'Опаздываю на смену, шеф!', 'Вон туда, к тем огням. Плачу щедро.', 'Только не трясите — я с тортом.'];
            r.game.hud.setSubtitle('Пассажир', lines[Math.floor(Math.random() * lines.length)], '#e0e0e0');
            setTimeout(() => r.game.hud.setSubtitle('', ''), 3000);
          }),
          S.lazy((r) => S.goTo(() => (r.data.dest as THREE.Vector3).clone(), { r: 5, text: 'Отвезите пассажира', vehicle: () => r.data.taxi as Vehicle, time: r.data.time as number })),
          S.run((r) => {
            const fare = r.data.fare as number;
            r.game.economy.add(fare, 'Такси');
            r.game.economy.stats.taxiFares++;
            r.data.earned = (r.data.earned as number) + fare;
            r.game.hud.toast(`Оплата +$${fare}`, 'good');
            const c = r.data.client as Character;
            r.game.removeCharacter(c);
            r.chars.splice(r.chars.indexOf(c), 1);
          }),
        );
      }
      return steps;
    },
  };

  // ---------------------------------------------------------------- гонка
  const raceStart = node(11, 7, -4, -10);
  const race: MissionDef = {
    id: 'race', title: 'Уличная гонка', giver: 'R', story: false, reward: 1200,
    desc: 'Взнос $200. Первое место — $1200.',
    where: () => raceStart.clone(),
    build: (m) => {
      const cps = [node(11, 3, -3.5), node(7, 3, 0, 3.5), node(7, 7, 3.5), node(4, 7, 0, -3.5), node(4, 11, 3.5), node(11, 11, 0, -3.5), node(11, 7, -3.5)];
      return [
        S.run((r) => {
          if (!r.game.economy.spend(200)) { r.failReason = 'Нужно $200 на взнос'; r.data.nofunds = true; return; }
          const s = raceStart;
          r.game.player.enterVehicle(r.vehicle('sport', V(s.x, 0.5, s.z - 4), Math.PI, 0xe8e8e8));
          r.data.rivals = [0, 1, 2].map((k) => {
            const v = r.vehicle(k === 1 ? 'muscle' : 'sport', V(s.x + (k - 1) * 4 - (k === 1 ? 4 : 0) + 4, 0.5, s.z + 4 + k * 7), Math.PI);
            const d = r.game.spawnCharacter(undefined, 'civ', v.position());
            d.visible = false; d.vehicle = v; v.driver = d; r.chars.push(d);
            return v;
          });
          r.game.cameraRig.snapBehind(Math.PI);
        }),
        { update: (r) => (r.data.nofunds ? 'fail' : 'done') },
        S.run((r) => r.game.hud.showBanner('ВПЕРЁД!', '', 'good', 900)),
        S.race(cps, () => (m.data.rivals as Vehicle[]) ?? [], { text: 'Уличная гонка' }),
        S.run((r) => r.game.economy.stats.racesWon++),
      ];
    },
  };

  // ---------------------------------------------------------------- патруль
  const vig: MissionDef = {
    id: 'vigilante', title: 'Ночной патруль', giver: '★', story: false, reward: 1500,
    desc: 'Задержите угонщика на полицейской машине.',
    where: () => { const p = L.place('police'); return V(p.x, 0, p.z); },
    build: (m) => {
      const target = () => m.data.target as Vehicle;
      return [
        S.run((r) => {
          const s = r.def.where();
          const v = r.vehicle('police', V(s.x + 5, 0.5, s.z + 2), Math.PI / 2);
          r.data.car = v;
          v.tag = 'owned';
        }),
        S.enterVehicle(() => m.data.car as Vehicle, 'Садитесь в <b>патрульную машину</b>'),
        S.run((r) => {
          (r.data.car as Vehicle).siren = true;
          const p = r.game.player.vehicle!.position();
          const graph = r.game.world.graph;
          const n = graph.nodes.filter((q) => q.i >= 0 && Math.hypot(q.x - p.x, q.z - p.z) > 220 && Math.hypot(q.x - p.x, q.z - p.z) < 380)[0] ?? graph.nodes[50];
          const v = r.vehicle(Math.random() < 0.5 ? 'sport' : 'muscle', V(n.x + 3, 0.6, n.z), 0);
          const d = r.game.spawnCharacter(undefined, 'enemy', v.position());
          d.visible = false; d.vehicle = v; v.driver = d; r.chars.push(d);
          r.data.target = v;
          r.game.hud.setSubtitle('Рация', 'Всем постам: угнанная машина, подозреваемый вооружён. Остановить любой ценой.', '#9cd7ff');
          setTimeout(() => r.game.hud.setSubtitle('', ''), 4000);
        }),
        S.chase(target, { text: 'Уничтожьте машину <b>угонщика</b>', minHealth: 0.05, maxDist: 320 }),
      ];
    },
  };

  // ---------------------------------------------------------------- заказ Нины
  const order: MissionDef = {
    id: 'order', title: 'Заказ Нины', giver: 'N', story: false, reward: 0,
    desc: 'Пригнать машину заказанной модели (здоровье > 60%).',
    where: () => { const p = L.place('garage'); return V(p.x + 9, 0, p.z); },
    build: (m) => {
      const kinds: VehicleKind[] = ['sport', 'muscle', 'suv', 'taxi', 'van'];
      const want = kinds[Math.floor(Math.random() * kinds.length)];
      m.data.want = want;
      const garagePos = () => { const p = L.place('garage'); return V(p.x, 0, p.z); };
      return [
        S.talk([{ who: 'nina', text: `Клиент ищет «${SPECS[want].name}». Без царапин, Лев — ну, почти без царапин.` }], { phone: true }),
        {
          start(r) { r.objective(`Найдите и угоните <b>«${SPECS[want].name}»</b>`); },
          update(r) { const v = r.game.player.vehicle; return v && v.kind === want ? 'done' : 'run'; },
        },
        S.goTo(garagePos, { r: 6, text: 'Пригоните машину в <b>мастерскую</b>', vehicle: () => (m.game.player.vehicle?.kind === want ? m.game.player.vehicle : null) }),
        S.run((r) => {
          const v = r.game.player.vehicle!;
          const frac = v.health / v.maxHealth;
          const pay = Math.round(SPECS[want].price * 0.5 * Math.max(0.3, frac));
          r.game.economy.add(pay, 'Заказ Нины');
          r.game.hud.toast(`Нина заплатила $${pay}`, 'good');
          r.game.player.exitVehicle(true);
          r.game.vehicles.remove(v);
        }),
      ];
    },
  };

  return [taxi, race, vig, order];
}

/** Тайники (коллекционные предметы). */
export class Packages {
  readonly spots: THREE.Vector3[] = [];
  found = new Set<number>();
  private meshes: (THREE.Mesh | null)[] = [];
  private mat: THREE.MeshStandardMaterial;

  constructor(private game: Game) {
    const L = game.world.layout;
    const rng = new RNG(2024);
    // Парки, дворы, пляж, причалы, холмы, крыши низких домов.
    const blocks = L.blocks.filter((b) => b.district !== 'downtown');
    while (this.spots.length < 14) {
      const b = rng.pick(blocks);
      const p = V(rng.range(b.inner.x0 + 2, b.inner.x1 - 2), 0.15, rng.range(b.inner.z0 + 2, b.inner.z1 - 2));
      if (b.buildings.some((q) => p.x > q.bounds.x0 - 1 && p.x < q.bounds.x1 + 1 && p.z > q.bounds.z0 - 1 && p.z < q.bounds.z1 + 1)) continue;
      this.spots.push(p);
    }
    const ter = game.world.terrain;
    for (const [x, z] of [[-200, 870], [400, 860], [1180, -460], [1150, 440], [-60, -1350], [-320, -930]]) this.spots.push(V(x, ter.groundHeight(x, z) > -0.5 ? ter.groundHeight(x, z) : 0, z));
    this.mat = MaterialLib.std({ color: 0x8a5a2a, emissive: 0x332200, roughness: 0.5, metalness: 0.3 });
    const geo = new THREE.BoxGeometry(0.5, 0.36, 0.14);
    for (const p of this.spots) {
      const m = new THREE.Mesh(geo, this.mat);
      m.position.copy(p).add(V(0, 0.5, 0));
      m.castShadow = true;
      game.engine.scene.add(m);
      this.meshes.push(m);
    }
  }

  setFound(ids: number[]) {
    for (const i of ids) { this.found.add(i); this.meshes[i]?.removeFromParent(); this.meshes[i] = null; }
  }

  update(dt: number) {
    const g = this.game;
    const p = g.player.char.pos;
    this.meshes.forEach((m, i) => {
      if (!m) return;
      m.rotation.y += dt * 1.5;
      m.position.y = this.spots[i].y + 0.55 + Math.sin(g.time * 2 + i) * 0.1;
      if (p.distanceTo(this.spots[i]) < 1.4) {
        m.removeFromParent();
        this.meshes[i] = null;
        this.found.add(i);
        g.economy.stats.packages = this.found.size;
        g.audio.ui('pickup');
        g.economy.add(250, 'Тайник');
        g.hud.toast(`Тайник найден: ${this.found.size}/${this.spots.length} · +$250`, 'good');
        if (this.found.size === this.spots.length) {
          g.economy.add(10000, 'Все тайники');
          g.player.char.armor = 100;
          g.hud.showBanner('ВСЕ ТАЙНИКИ НАЙДЕНЫ', '+$10 000 и бронежилет', 'good');
        }
      }
    });
  }
}
