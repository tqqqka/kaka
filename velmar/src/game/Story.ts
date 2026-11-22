/**
 * Сюжет «VELMAR: Ночной прилив» — 8 миссий.
 *
 * Лев Корсак, бывший гонщик-водитель, выходит после пяти лет колонии, куда попал,
 * взяв на себя чужое ограбление. Его старый босс Гена «Седой» Ломов встречает его как друга.
 * Механик Нина Варга даёт ему крышу. Город подмял под себя застройщик Аркадий Сабуров —
 * «Барон», хозяин порта и строящегося Шпиля.
 * Поворот 1: Седой работает на Барона и подставил Льва пять лет назад — и подставляет снова.
 * Поворот 2: капитан полиции Ирина Дробова, которая будто бы охотится за Львом,
 * на самом деле годами собирает дело против Барона.
 */
import * as THREE from 'three';
import { S, type MissionDef, type MissionRun } from './Missions';
import { lineX, lineZ, type CityLayout } from '../world/CityLayout';
import type { Vehicle } from '../entities/Vehicle';
import { makeShooter, type ShooterAI } from '../ai/ShooterAI';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** Точка перекрёстка сетки (i, j) со смещением. */
const node = (i: number, j: number, dx = 0, dz = 0) => V(lineX(i) + dx, 0, lineZ(j) + dz);

export function storyMissions(L: CityLayout): MissionDef[] {
  const bar = L.blockByIndex(7, 9)!;
  const barPos = () => V((bar.x0 + bar.x1) / 2, 0, bar.z1 + 1.5);
  const garage = () => { const p = L.place('garage'); return V(p.x, 0, p.z); };
  const P = (id: string) => () => { const p = L.place(id); return V(p.x, 0, p.z); };

  // ---------------------------------------------------------------- 1
  const m1: MissionDef = {
    id: 'm1', title: 'Возвращение', giver: 'sedoy', story: true, reward: 500,
    desc: 'Лев выходит на свободу. Седой встречает его на автовокзале.',
    where: P('bus'),
    build: (m) => {
      const bus = L.place('bus');
      const car = () => m.data.car as Vehicle;
      return [
        S.run((r) => {
          const p = r.game.player;
          p.teleport(V(bus.x, 0.2, bus.z), 0);
          r.actor('sedoy', 'sedoy', V(bus.x + 1.8, 0.15, bus.z + 2.4), Math.PI);
          r.data.car = r.vehicle('muscle', V(bus.x + 6, 0.5, bus.z - 3.5), Math.PI / 2, 0x3a3226);
          r.game.cameraRig.snapBehind(0);
        }),
        S.talk([
          { who: 'sedoy', text: 'Лёва! Пять лет, а ты всё такой же хмурый. С возвращением в Порт-Вельмар.' },
          { who: 'lev', text: 'Пять лет за чужое дело, Гена. Город, смотрю, подрос.' },
          { who: 'sedoy', text: 'Город теперь принадлежит Барону. Сабуров скупил порт и строит свой Шпиль до самого неба.' },
          { who: 'lev', text: 'А ты? Всё ещё возишь чужие деньги?' },
          { who: 'sedoy', text: 'Я выживаю. И тебе помогу. Бери «Буйвола» — Нина ждёт в мастерской, она даст тебе угол.' },
        ], { listener: 'sedoy' }),
        S.enterVehicle(car, 'Сядьте в машину <b>«Буйвол»</b>'),
        S.run((r) => { r.game.hud.toast('W/S — газ/тормоз, A/D — руль, Пробел — ручник', 'info'); }),
        S.goTo(garage, { r: 4, text: 'Езжайте в <b>мастерскую Нины</b>', vehicle: 'any' }),
        S.run((r) => {
          const g = garage();
          r.actor('nina', 'nina', V(g.x + 2, 0.15, g.z - 3.5), Math.PI);
        }),
        S.goTo(() => garage().add(V(0, 0, -2)), { r: 2.5, text: 'Выйдите и поговорите с <b>Ниной</b>', vehicle: 'none' }),
        S.talk([
          { who: 'nina', text: 'Лев Корсак. Живой. А я думала, ты сгнил в Северной колонии.' },
          { who: 'lev', text: 'Не дождёшься. Мне нужна работа и крыша над головой.' },
          { who: 'nina', text: 'Крыша — вот она. Мастерская теперь и твоя: здесь можно сохраниться, починить и прокачать тачку.' },
          { who: 'nina', text: 'А работу тебе даст Седой. Только... я бы ему не доверяла. Он слишком быстро поднялся, пока ты сидел.' },
        ], { listener: 'nina' }),
        S.run((r) => r.game.hud.toast('Жёлтые маркеры на карте — сюжетные миссии. Голубые — подработка.', 'info')),
      ];
    },
  };

  // ---------------------------------------------------------------- 2
  const m2: MissionDef = {
    id: 'm2', title: 'Долги', giver: 'sedoy', story: true, reward: 1500,
    desc: 'Седой просит выбить долг у Жоры Шныря.',
    where: barPos,
    build: (m) => {
      const yard = L.blockByIndex(5, 8)!;
      const yc = V((yard.inner.x0 + yard.inner.x1) / 2, 0.15, yard.z1 - 2);
      return [
        S.run((r) => { const b = barPos(); r.actor('sedoy', 'sedoy', V(b.x + 1.5, 0.15, b.z - 2.5), Math.PI); }),
        S.talk([
          { who: 'sedoy', text: 'Есть дело. Жора Шнырь занял у наших людей и решил, что можно не отдавать.' },
          { who: 'sedoy', text: 'Держи «Осу» — пистолет пристрелян. Забери долг. Покажи, что ты вернулся.' },
          { who: 'lev', text: 'Я водитель, Гена, а не коллектор.' },
          { who: 'sedoy', text: 'Сегодня ты тот, кем нужно быть. Кирпичный квартал, двор у прачечной.' },
        ], { listener: 'sedoy' }),
        S.run((r) => { r.game.player.giveWeapon('pistol', 48); r.game.player.selectWeapon('pistol'); r.game.hud.toast('Получен пистолет «Оса-9». ПКМ/кнопка прицела — целиться.', 'good'); }),
        S.goTo(() => yc.clone(), { r: 5, text: 'Найдите <b>Жору Шныря</b>' }),
        S.run((r) => {
          r.actor('zhora', 'thug', V(yc.x, 0.15, yc.z - 6), 0, 'enemy');
          const z = r.actors.get('zhora')!;
          z.setWeapon('fist');
          for (let k = 0; k < 4; k++) r.enemy(V(yc.x - 8 + k * 5, 0.15, yc.z - 12 - (k % 2) * 3), k < 2 ? 'pistol' : 'fist', { mode: 'hold' });
        }),
        S.talk([
          { who: 'zhora', text: 'Корсак?! Ты же сидел! Слушай, денег нет, клянусь...' },
          { who: 'lev', text: 'Деньги есть всегда, Жора. Вопрос — у кого.' },
          { who: 'zhora', text: 'Пацаны! Валите его!' },
        ], { listener: 'zhora' }),
        S.run((r) => {
          const z = r.actors.get('zhora')!;
          r.enemies.push(z);
          for (const e of r.enemies) { const ai = e.brain as ShooterAI; if (ai) { ai.mode = 'attack'; ai.target = r.game.player.char; } }
          makeShooter(z, 'pistol', { mode: 'attack', target: r.game.player.char });
        }),
        S.killAll('Разберитесь с бандой Шныря'),
        S.run((r) => {
          const p = r.actors.get('zhora')?.pos ?? yc;
          r.data.case = p.clone();
        }),
        S.goTo(() => (m.data.case as THREE.Vector3).clone(), { r: 1.6, text: 'Заберите <b>кейс с деньгами</b>', vehicle: 'none', color: 0x57e38a }),
        S.goTo(barPos, { r: 4, text: 'Отвезите деньги <b>Седому</b>' }),
        S.run((r) => { const b = barPos(); r.actor('sedoy', 'sedoy', V(b.x + 1.5, 0.15, b.z - 2.5), Math.PI); }),
        S.talk([
          { who: 'sedoy', text: 'Вот это я понимаю — вернулся! Твоя доля. И, Лёва... рад, что ты снова с нами.' },
          { who: 'lev', text: 'Посмотрим, надолго ли.' },
        ]),
      ];
    },
  };

  // ---------------------------------------------------------------- 3
  const raceCps = () => [node(9, 5, -3.5), node(12, 5, 0, 3.5), node(12, 2, 3.5), node(16, 2, 0, -3.5), node(16, 8, -3.5), node(13, 8, 0, 3.5), node(13, 11, 3.5), node(9, 11, 0, -3.5), node(9, 8, -3.5)];
  const m3: MissionDef = {
    id: 'm3', title: 'Ночной забег', giver: 'knut', story: true, reward: 3000,
    desc: 'Уличная гонка через деловой центр. Победитель забирает всё.',
    where: () => node(9, 9, 6, 9),
    build: (m) => {
      const rivals = () => (m.data.rivals as Vehicle[]) ?? [];
      return [
        S.fade((r) => {
          if (r.game.hours > 5 && r.game.hours < 21) r.game.hours = 22.5;
          const s = node(9, 9, 0, 0);
          const p = r.game.player;
          const car = r.vehicle('sport', V(s.x - 3.5, 0.5, s.z - 14), Math.PI, 0xc01818);
          p.enterVehicle(car);
          const cols = [0xf0c020, 0x1d5fd0, 0x26a050];
          r.data.rivals = [0, 1, 2].map((k) => {
            const v = r.vehicle(k === 2 ? 'muscle' : 'sport', V(s.x + (k % 2 ? 3.5 : -3.5) * (k ? 1 : -1) + (k === 0 ? 7 : 0), 0.5, s.z - 14 + (k === 0 ? 0 : 8)), Math.PI, cols[k]);
            v.driver = r.game.spawnCharacter(undefined, 'civ', v.position());
            v.driver.visible = false;
            v.driver.vehicle = v;
            r.chars.push(v.driver);
            return v;
          });
          r.actor('knut', 'thug', V(s.x + 8.5, 0.15, s.z - 20), -Math.PI / 2);
          r.game.cameraRig.snapBehind(Math.PI);
        }, 'Ночь. Площадь у делового центра'),
        S.talk([
          { who: 'knut', text: 'Новенький на красной «Стреле»? Ставка — три штуки. Девять точек через центр.' },
          { who: 'knut', text: 'Правил нет. Копов не жалко. Кто последний — оплачивает бензин всем.' },
          { who: 'lev', text: 'Пять лет не садился за руль. Самое время вспомнить.' },
        ], { phone: true }),
        S.run((r) => { r.game.hud.showBanner('3', '', 'info', 700); }),
        S.wait(0.9),
        S.run((r) => { r.game.hud.showBanner('2', '', 'info', 700); }),
        S.wait(0.9),
        S.run((r) => { r.game.hud.showBanner('1', '', 'info', 700); }),
        S.wait(0.9),
        S.run((r) => { r.game.hud.showBanner('ВПЕРЁД!', '', 'good', 900); r.game.audio.ui('ok'); }),
        S.race(raceCps(), rivals, { text: 'Гонка' }),
        S.talk([
          { who: 'knut', text: 'Ха! Корсак, ты не разучился. Держи свои три тысячи. И слушай...' },
          { who: 'knut', text: 'Люди Барона спрашивали про тебя. Будь осторожен.' },
        ], { phone: true }),
      ];
    },
  };

  // ---------------------------------------------------------------- 4
  const m4: MissionDef = {
    id: 'm4', title: 'Тихая гавань', giver: 'nina', story: true, reward: 2500,
    desc: 'Нина просит сфотографировать груз Барона на Складе №7 в порту.',
    where: garage,
    build: (m) => {
      const wh = L.place('warehouse');
      const wb = L.specialBlock('warehouse');
      const I = wb.inner;
      return [
        S.run((r) => { const g = garage(); r.actor('nina', 'nina', V(g.x + 2, 0.15, g.z - 3.5), Math.PI); }),
        S.talk([
          { who: 'nina', text: 'Ко мне заходил парень из порта. Говорит, по ночам на Седьмой склад привозят что-то, чего нет в накладных.' },
          { who: 'nina', text: 'Склад принадлежит Барону. Мне нужны снимки. Без стрельбы — тихо, как кошка.' },
          { who: 'lev', text: 'А если меня заметят?' },
          { who: 'nina', text: 'Тогда беги. Я оставлю катер у причала. Пригнись (C) — в темноте и в приседе охрана видит хуже.' },
        ], { listener: 'nina' }),
        S.run((r) => { if (r.game.hours > 5 && r.game.hours < 20) r.game.hours = 23; }),
        S.goTo(() => V(wh.x - 25, 0, wh.z), { r: 5, text: 'Доберитесь до <b>Склада №7</b> в порту' }),
        S.run((r) => {
          const pts = [
            [V(I.x0 + 4, 0.15, I.z0 + 6), V(I.x1 - 4, 0.15, I.z0 + 6)],
            [V(I.x1 - 4, 0.15, I.z1 - 4), V(I.x0 + 4, 0.15, I.z1 - 4)],
            [V(I.x0 + 3, 0.15, I.z0 + 10), V(I.x0 + 3, 0.15, I.z1 - 10)],
            [V(I.x1 - 3, 0.15, I.z1 - 10), V(I.x1 - 3, 0.15, I.z0 + 10)],
            [V((I.x0 + I.x1) / 2, 0.15, I.z1 - 8), V((I.x0 + I.x1) / 2 + 12, 0.15, I.z1 - 8)],
          ];
          for (const [a, b] of pts) {
            const e = r.enemy(a.clone(), 'smg', { mode: 'patrol', patrol: [a, b], vision: 19, fov: 0.75, accuracy: 0.6 }, 'guard');
            e.yaw = Math.atan2(b.x - a.x, b.z - a.z);
          }
          r.data.boat = r.vehicle('boat', V(1030, 0, wh.z + 40), Math.PI / 2, 0x1d3f8c);
        }),
        S.stealth([V(I.x0 + 2, 0.15, I.z1 - 18), V((I.x0 + I.x1) / 2, 0.15, I.z1 - 24), V(I.x1 - 2.5, 0.15, I.z0 + 20)], 'Сфотографируйте груз, не попавшись охране'),
        S.talk([
          { who: 'lev', text: 'Ящики с гербом мэрии... и машина Седого у ворот. Что он тут делает?' },
          { who: 'radio', text: 'Пост два, проверка периметра. Кто-то крутился у грузовика!' },
        ], { phone: true }),
        S.run((r) => { for (const e of r.enemies) { const ai = e.brain as ShooterAI; ai.mode = 'attack'; ai.target = r.game.player.char; } r.game.police?.addCrime('mission', r.game.player.char.pos, 1); }),
        S.enterVehicle(() => m.data.boat as Vehicle, 'Уходите на <b>катере</b> у причала'),
        S.goTo(() => V(1300, 0, 760), { r: 14, text: 'Уплывите <b>подальше от порта</b>', vehicle: 'any', stop: false }),
        S.talk([
          { who: 'nina', text: 'Снимки получила. Лев... на одном из них Седой жмёт руку начальнику охраны Барона.' },
          { who: 'lev', text: 'Значит, старик всё это время был на другой стороне.' },
        ], { phone: true }),
      ];
    },
  };

  // ---------------------------------------------------------------- 5
  const m5: MissionDef = {
    id: 'm5', title: 'Бронированный', giver: 'sedoy', story: true, reward: 8000,
    desc: 'Перехватить инкассаторский броневик Барона.',
    where: barPos,
    build: (m) => {
      const van = () => m.data.van as Vehicle;
      return [
        S.run((r) => { const b = barPos(); r.actor('sedoy', 'sedoy', V(b.x + 1.5, 0.15, b.z - 2.5), Math.PI); }),
        S.talk([
          { who: 'sedoy', text: 'Слышал, ты катался в порт. Не лезь туда, Лёва. Лучше заработай по-человечески.' },
          { who: 'sedoy', text: 'Броневик Барона везёт недельную выручку казино. Маршрут — от Ржавого Пояса на запад.' },
          { who: 'sedoy', text: 'Помни ему бока, пока водила не сдастся, и гони к Нине. Копы сядут на хвост — это нормально.' },
          { who: 'lev', text: 'А ты где будешь, Гена?' },
          { who: 'sedoy', text: 'Там, где положено старикам. В тени.' },
        ], { listener: 'sedoy' }),
        S.run((r) => {
          r.game.player.giveWeapon('smg', 90);
          const start = node(15, 6, 0, 3.5);
          r.data.van = r.vehicle('armored', V(start.x - 10, 0.6, start.z), -Math.PI / 2, 0x4a5048);
          const v = r.data.van as Vehicle;
          v.driver = r.game.spawnCharacter(undefined, 'enemy', v.position());
          v.driver.visible = false; v.driver.vehicle = v; r.chars.push(v.driver);
          r.game.hud.toast('Получен ПП «Шершень»', 'good');
          r.guards.push(() => (v.destroyed ? 'Броневик уничтожен — деньги сгорели' : null));
        }),
        S.goTo(() => van().position(), { r: 60, text: 'Перехватите <b>броневик</b>', stop: false }),
        {
          start(r) { r.objective('Повредите броневик, чтобы он остановился'); r.arrow(0xff3b4e, undefined, van()); r.blip({ kind: 'target', vehicle: van(), color: '#ff3b4e' }); },
          update(r, dt) {
            const v = van();
            const frac = v.health / v.maxHealth;
            r.game.hud.setObjective(`Повредите броневик <b>${Math.round(frac * 100)}%</b>`);
            if (frac < 0.55) return 'done';
            const goal = node(3, 12);
            r.driver(v).driveSmart(goal, 22, dt);
            if (v.position().distanceTo(goal) < 30) { r.failReason = 'Броневик ушёл'; return 'fail'; }
            return 'run';
          },
          end(r) { r.clearMarks(); },
        },
        S.run((r) => {
          const v = van();
          r.driver(v).stop();
          v.ctl.handbrake = true;
          if (v.driver) { v.driver.vehicle = null; r.game.removeCharacter(v.driver); v.driver = null; }
          r.game.hud.toast('Водитель сбежал!', 'good');
          r.game.police?.setMinWanted(2);
        }),
        S.enterVehicle(van, 'Захватите <b>броневик</b>'),
        S.goTo(garage, { r: 6, text: 'Доставьте броневик в <b>мастерскую</b>', vehicle: van }),
        S.run((r) => r.game.police?.setMinWanted(0)),
        S.run((r) => { r.game.police?.clear(); }),
        S.talk([
          { who: 'nina', text: 'Броневик?! Ты с ума сошёл... Ладно, загоняй, я спрячу. Копам скажу, что ты тут не был.' },
          { who: 'nina', text: 'В кейсах не только деньги. Тут бухгалтерия Барона. И фамилия Ломов — везде.' },
        ], { phone: true }),
      ];
    },
  };

  // ---------------------------------------------------------------- 6
  const m6: MissionDef = {
    id: 'm6', title: 'Двойное дно', giver: 'sedoy', story: true, reward: 4000,
    desc: 'Седой назначает «сделку» на стройке «Горизонт». Это ловушка.',
    where: barPos,
    build: (m) => {
      const cb = L.specialBlock('construction');
      const I = cb.inner;
      const cx = (I.x0 + I.x1) / 2, cz = (I.z0 + I.z1) / 2;
      return [
        S.talk([
          { who: 'sedoy', text: 'Лёва, срочное дело. Покупатель на бумаги из броневика. Стройка «Горизонт», через час.' },
          { who: 'lev', text: 'Откуда ты знаешь про бумаги, Гена? Я тебе о них не говорил.' },
          { who: 'sedoy', text: '...Город маленький. Приезжай один.' },
        ], { phone: true }),
        S.run((r) => { if (r.game.hours > 5 && r.game.hours < 20) r.game.hours = 21; }),
        S.goTo(P('construction'), { r: 5, text: 'Приезжайте на <b>стройку «Горизонт»</b>' }),
        S.run((r) => {
          const spots = [[cx - 14, cz - 10], [cx + 14, cz - 10], [cx - 12, cz + 12], [cx + 12, cz + 12], [cx, cz - 14], [cx + 18, cz], [cx - 18, cz + 2], [cx, cz + 15]];
          spots.forEach(([x, z], k) => r.enemy(V(x, 0.15, z), k % 3 === 0 ? 'rifle' : k % 3 === 1 ? 'smg' : 'shotgun', { mode: 'hold', accuracy: 0.5, holdDist: 14 }, 'guard'));
          r.actor('thug', 'guard', V(cx - 6, 0.15, cz - 18), 0, 'enemy');
        }),
        S.talk([
          { who: 'thug', text: 'Корсак. Седой сказал, ты придёшь с бумагами. Барон передаёт привет.' },
          { who: 'lev', text: 'Седой много чего говорит.' },
        ], { listener: 'thug' }),
        S.run((r) => {
          const t = r.actors.get('thug')!;
          r.actors.delete('thug');
          makeShooter(t, 'pistol', { mode: 'attack', target: r.game.player.char });
          r.enemies.push(t);
          for (const e of r.enemies) { const ai = e.brain as ShooterAI; if (ai) { ai.mode = 'attack'; ai.target = r.game.player.char; } }
          r.game.player.giveWeapon('rifle', 60);
          r.game.hud.toast('Подобран автомат «Сокол». C — укрытие у стены.', 'good');
        }),
        S.killAll('Отбейтесь от засады'),
        S.talk([
          { who: 'lev', text: 'Седой... Пять лет назад «случайная» облава на нашем маршруте. Только он знал, где мы поедем.' },
          { who: 'lev', text: 'Он сдал меня тогда. И сдал сейчас.' },
        ], { phone: true }),
      ];
    },
  };

  // ---------------------------------------------------------------- 7
  const m7: MissionDef = {
    id: 'm7', title: 'Крыса', giver: 'sedoy', story: true, reward: 5000,
    desc: 'Седой пытается сбежать из города. Догнать.',
    where: barPos,
    build: (m) => {
      const car = () => m.data.car as Vehicle;
      return [
        S.run((r) => {
          const b = barPos();
          r.data.car = r.vehicle('muscle', V(b.x + 12, 0.6, b.z + 4), Math.PI / 2, 0xb8b8b8);
          const v = r.data.car as Vehicle;
          r.actor('sedoy', 'sedoy', v.position(), 0, 'enemy');
          const s = r.actors.get('sedoy')!;
          s.visible = false; s.vehicle = v; v.driver = s;
        }),
        S.talk([
          { who: 'lev', text: 'Гена!' },
          { who: 'sedoy', text: 'Ты должен был остаться на той стройке, Лёва! Прости — это бизнес!' },
        ], { phone: true }),
        S.chase(car, { text: 'Догоните и разбейте машину <b>Седого</b>', minHealth: 0.25 }),
        S.run((r) => {
          const v = car();
          r.driver(v).stop();
          const s = r.actors.get('sedoy')!;
          const p = v.exitPoint(V(0, 0, 0));
          s.pos.copy(p).setY(r.game.world.surfaceHeight(p.x, p.z));
          s.vehicle = null; s.visible = true; v.driver = null;
          s.model.anim.cower = true;
        }),
        S.goTo(() => (m.actors.get('sedoy')?.pos ?? V(0, 0, 0)).clone(), { r: 3, text: 'Подойдите к <b>Седому</b>', vehicle: 'none' }),
        S.talk([
          { who: 'sedoy', text: 'Не стреляй... Барон держал меня за горло двадцать лет. Ты бы сделал то же самое!' },
          { who: 'lev', text: 'Я пять лет смотрел на решётку за тебя, Гена. Нет. Я бы так не сделал.' },
          { who: 'drobova', text: 'Корсак, это капитан Дробова. Опусти оружие и послушай.' },
          { who: 'drobova', text: 'Я знаю, что ограбление пятилетней давности было не твоим. Я восемь лет собираю дело на Сабурова.' },
          { who: 'drobova', text: 'Ломова я забираю — он даст показания. А тебе нужен Барон. Приходи в мастерскую, обсудим.' },
        ], { listener: 'sedoy' }),
        S.fade((r) => {
          const s = r.actors.get('sedoy');
          if (s) { r.actors.delete('sedoy'); r.game.removeCharacter(s); r.chars.splice(r.chars.indexOf(s), 1); }
        }, 'Ломова увозит полиция'),
      ];
    },
  };

  // ---------------------------------------------------------------- 8
  const m8: MissionDef = {
    id: 'm8', title: 'Шпиль', giver: 'drobova', story: true, reward: 25000,
    desc: 'Финал: вертолёт, крыша Шпиля Сабурова и Барон.',
    where: garage,
    build: (m) => {
      const sb = L.specialBlock('spire');
      const roof = V((sb.inner.x0 + sb.inner.x1) / 2, 291, (sb.inner.z0 + sb.inner.z1) / 2);
      const heli = () => m.data.heli as Vehicle;
      return [
        S.run((r) => {
          const g = garage();
          r.actor('drobova', 'drobova', V(g.x + 2.5, 0.15, g.z - 3), Math.PI);
          r.actor('nina', 'nina', V(g.x - 1.5, 0.15, g.z - 3.5), Math.PI);
        }),
        S.talk([
          { who: 'drobova', text: 'Ломов заговорил. Но Барон узнал об этом раньше, чем мы успели подписать ордер. Утечка в моём же отделе.' },
          { who: 'drobova', text: 'На крыше Шпиля его вертолёт. Через двадцать минут Сабуров будет за границей.' },
          { who: 'nina', text: 'В порту на площадке стоит вертолёт. Я его «одолжила». Лев, ты умеешь летать?' },
          { who: 'lev', text: 'Если умею водить — разберусь и с этим.' },
          { who: 'drobova', text: 'Задержи его на крыше. Я подниму группу. И, Корсак... постарайся, чтобы он дожил до суда.' },
        ], { listener: 'drobova' }),
        S.run((r) => {
          const h = L.place('helipad');
          r.data.heli = r.vehicle('heli', V(h.x, 0.5, h.z), -Math.PI / 2, 0x1a1a1a);
          r.guards.push(() => (heli().destroyed && r.idx < 6 ? 'Вертолёт уничтожен' : null));
          r.game.player.giveWeapon('rifle', 120);
          r.game.player.char.armor = 100;
          r.game.hud.toast('Пробел/газ — вверх, Shift/тормоз — вниз, стик — наклон, Q/E — поворот', 'info');
        }),
        S.goTo(P('helipad'), { r: 8, text: 'Доберитесь до <b>вертолётной площадки</b> в порту' }),
        S.enterVehicle(heli, 'Садитесь в <b>вертолёт</b>'),
        S.goTo(() => roof.clone(), { r: 16, text: 'Летите к <b>Шпилю Сабурова</b> и сядьте на крышу', vehicle: 'any', stop: false, air: true }),
        {
          start(r) {
            r.objective('Посадите вертолёт на площадку');
            for (let k = 0; k < 6; k++) {
              const a = (k / 6) * Math.PI * 2;
              r.enemy(V(roof.x + Math.cos(a) * 10, roof.y, roof.z + Math.sin(a) * 10), k % 2 ? 'rifle' : 'smg', { mode: 'hold', accuracy: 0.45 }, 'guard');
            }
            r.actor('baron', 'baron', V(roof.x + 3, roof.y, roof.z - 9), 0, 'enemy');
          },
          update(r) {
            const v = r.game.player.vehicle;
            if (!v) return r.game.player.char.pos.y > 280 ? 'done' : 'run';
            if (v.position().distanceTo(roof) < 18 && v.wheelsOnGround === 0 && Math.abs(v.linvel().y) < 1.5 && v.position().y < roof.y + 3) return 'done';
            return 'run';
          },
        },
        S.run((r) => { for (const e of r.enemies) { const ai = e.brain as ShooterAI; ai.mode = 'attack'; ai.target = r.game.player.char; } }),
        S.killAll('Перебейте охрану Барона на крыше'),
        S.goTo(() => (m.actors.get('baron')?.pos ?? roof).clone(), { r: 3, text: 'Задержите <b>Барона</b>', vehicle: 'none', air: true }),
        S.talk([
          { who: 'baron', text: 'Корсак. Водитель, который возомнил себя героем. Этот город построен на мне — каждый бетонный блок!' },
          { who: 'lev', text: 'Город построили люди, которых ты обокрал. Пять лет моей жизни — тоже в твоём фундаменте.' },
          { who: 'baron', text: 'Назови цену. У каждого есть цена.' },
          { who: 'lev', text: 'Моя — твоё лицо на первой полосе. В наручниках.' },
          { who: 'drobova', text: 'Аркадий Сабуров, вы арестованы. Корсак — спасибо. Обвинения пятилетней давности с тебя сняты.' },
        ], { listener: 'baron' }),
        S.fade((r) => {
          r.game.hours = 6.2;
          const b = r.actors.get('baron');
          if (b) { r.actors.delete('baron'); r.game.removeCharacter(b); }
        }, 'Рассвет над Порт-Вельмаром'),
        S.talk([
          { who: 'nina', text: 'Ну что, Лев Корсак, свободный человек. Чем займёшься?' },
          { who: 'lev', text: 'Тем, что умею. Буду кататься по этому городу, пока он снова не попросит о помощи.' },
        ], { phone: true }),
        S.run((r) => r.game.hud.showBanner('VELMAR: НОЧНОЙ ПРИЛИВ', 'Сюжет пройден · Город открыт для свободной игры', 'good', 7000)),
      ];
    },
  };

  return [m1, m2, m3, m4, m5, m6, m7, m8];
}

export type { MissionRun };
