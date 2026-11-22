/**
 * Процедурный звук (WebAudio): никаких аудиофайлов. Выстрелы, взрывы, удары, шаги,
 * двигатели, сирены, вертолёт, дождь, гром, городской гул и генеративное «радио»
 * (три станции: синтвейв, лоу-фай бит, ночной джаз).
 */
import * as THREE from 'three';
import type { WeaponId } from '../entities/Weapons';

const _v = new THREE.Vector3();

export class EngineSound {
  private o1: OscillatorNode;
  private o2: OscillatorNode;
  private nz: AudioBufferSourceNode;
  private nzGain: GainNode;
  private filt: BiquadFilterNode;
  private gain: GainNode;
  readonly panner: PannerNode;
  private lfo: OscillatorNode | null = null;
  constructor(private a: AudioEngine, readonly kind: 'car' | 'moto' | 'heli' | 'boat') {
    const ctx = a.ctx!;
    this.panner = a.makePanner(10);
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.filt = ctx.createBiquadFilter();
    this.filt.type = 'lowpass';
    this.filt.frequency.value = 600;
    this.filt.Q.value = 2;
    this.o1 = ctx.createOscillator();
    this.o1.type = 'sawtooth';
    this.o2 = ctx.createOscillator();
    this.o2.type = kind === 'moto' ? 'square' : 'sawtooth';
    this.nz = a.noiseSource();
    this.nzGain = ctx.createGain();
    this.nzGain.gain.value = kind === 'heli' ? 0.9 : kind === 'boat' ? 0.35 : 0.12;
    const g2 = ctx.createGain();
    g2.gain.value = kind === 'heli' ? 0.15 : 0.5;
    this.o1.connect(this.filt);
    this.o2.connect(g2).connect(this.filt);
    this.nz.connect(this.nzGain).connect(this.filt);
    if (kind === 'heli') {
      // «Хлопки» лопастей: амплитудная модуляция.
      const am = ctx.createGain();
      am.gain.value = 0.5;
      this.lfo = ctx.createOscillator();
      this.lfo.frequency.value = 16;
      const lg = ctx.createGain();
      lg.gain.value = 0.5;
      this.lfo.connect(lg).connect(am.gain);
      this.filt.connect(am).connect(this.gain);
      this.lfo.start();
    } else this.filt.connect(this.gain);
    this.gain.connect(this.panner).connect(a.sfx!);
    this.o1.start();
    this.o2.start();
    this.nz.start();
  }
  /** rpm 0..1, load 0..1 */
  set(pos: THREE.Vector3, rpm: number, load: number, vol: number) {
    const t = this.a.ctx!.currentTime;
    const base = this.kind === 'moto' ? 55 : this.kind === 'heli' ? 40 : this.kind === 'boat' ? 45 : 38;
    const f = base + rpm * (this.kind === 'moto' ? 170 : 110);
    this.o1.frequency.setTargetAtTime(f, t, 0.05);
    this.o2.frequency.setTargetAtTime(f * 2.01, t, 0.05);
    this.filt.frequency.setTargetAtTime(this.kind === 'heli' ? 900 : 250 + load * 1600 + rpm * 900, t, 0.05);
    if (this.lfo) this.lfo.frequency.setTargetAtTime(10 + rpm * 10, t, 0.1);
    this.gain.gain.setTargetAtTime(vol * (0.05 + load * 0.08 + rpm * 0.05) * (this.kind === 'heli' ? 2.2 : 1), t, 0.08);
    this.a.placePanner(this.panner, pos);
  }
  stop() {
    const t = this.a.ctx!.currentTime;
    this.gain.gain.setTargetAtTime(0, t, 0.1);
    setTimeout(() => {
      try { this.o1.stop(); this.o2.stop(); this.nz.stop(); this.lfo?.stop(); } catch { /* уже остановлено */ }
      this.panner.disconnect();
    }, 400);
  }
}

export class SirenSound {
  private osc: OscillatorNode;
  private lfo: OscillatorNode;
  private gain: GainNode;
  readonly panner: PannerNode;
  constructor(private a: AudioEngine) {
    const ctx = a.ctx!;
    this.panner = a.makePanner(20);
    this.osc = ctx.createOscillator();
    this.osc.type = 'sine';
    this.osc.frequency.value = 900;
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 0.3;
    const lg = ctx.createGain();
    lg.gain.value = 380;
    this.lfo.connect(lg).connect(this.osc.frequency);
    this.gain = ctx.createGain();
    this.gain.gain.value = 0.0;
    const sh = ctx.createWaveShaper();
    const curve = new Float32Array(256).map((_, i) => Math.tanh(((i / 128) - 1) * 3));
    sh.curve = curve;
    this.osc.connect(sh).connect(this.gain).connect(this.panner).connect(a.sfx!);
    this.osc.start();
    this.lfo.start();
  }
  set(pos: THREE.Vector3, vol: number) {
    this.gain.gain.setTargetAtTime(vol * 0.06, this.a.ctx!.currentTime, 0.1);
    this.a.placePanner(this.panner, pos);
  }
  stop() {
    this.gain.gain.setTargetAtTime(0, this.a.ctx!.currentTime, 0.05);
    setTimeout(() => { try { this.osc.stop(); this.lfo.stop(); } catch { /* */ } this.panner.disconnect(); }, 300);
  }
}

interface Station { name: string; bpm: number; chords: number[][]; style: 'synth' | 'lofi' | 'jazz' }

export const STATIONS: Station[] = [
  { name: 'Волна 88 — синтвейв', bpm: 104, chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], style: 'synth' },
  { name: 'Бит FM — лоу-фай', bpm: 84, chords: [[50, 53, 57, 60], [55, 59, 62, 65], [48, 52, 55, 59], [45, 48, 52, 55]], style: 'lofi' },
  { name: 'Порт Джаз — ночное', bpm: 92, chords: [[50, 53, 57, 60], [55, 59, 62, 65], [48, 52, 55, 59], [57, 61, 64, 67]], style: 'jazz' },
];

export class AudioEngine {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  sfx: GainNode | null = null;
  music: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private rainGain: GainNode | null = null;
  private humGain: GainNode | null = null;
  volumes = { master: 0.8, sfx: 0.9, music: 0.45 };
  station = -1;
  private nextNote = 0;
  private step = 0;
  private schedTimer: number | null = null;
  private listenerPos = new THREE.Vector3();

  /** Создать контекст (нужен жест пользователя). */
  init() {
    if (this.ctx) { void this.ctx.resume(); return; }
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = (this.ctx = new Ctx());
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = this.volumes.master;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = this.volumes.sfx;
    this.sfx.connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = this.volumes.music;
    this.music.connect(this.master);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // Дождь.
    const rn = this.noiseSource();
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7000;
    this.rainGain = ctx.createGain(); this.rainGain.gain.value = 0;
    rn.connect(hp).connect(lp).connect(this.rainGain).connect(this.sfx);
    rn.start();
    // Городской гул.
    const hn = this.noiseSource();
    const hl = ctx.createBiquadFilter(); hl.type = 'lowpass'; hl.frequency.value = 260;
    this.humGain = ctx.createGain(); this.humGain.gain.value = 0.05;
    hn.connect(hl).connect(this.humGain).connect(this.sfx);
    hn.start();
  }

  setVolumes(v: Partial<{ master: number; sfx: number; music: number }>) {
    Object.assign(this.volumes, v);
    if (!this.ctx) return;
    this.master!.gain.value = this.volumes.master;
    this.sfx!.gain.value = this.volumes.sfx;
    this.music!.gain.value = this.volumes.music;
  }

  noiseSource(): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    return s;
  }

  makePanner(ref = 5): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = 1.1;
    p.maxDistance = 600;
    return p;
  }

  placePanner(p: PannerNode, pos: THREE.Vector3) {
    const t = this.ctx!.currentTime;
    p.positionX.setTargetAtTime(pos.x, t, 0.03);
    p.positionY.setTargetAtTime(pos.y, t, 0.03);
    p.positionZ.setTargetAtTime(pos.z, t, 0.03);
  }

  /** Позиция слушателя = камера. */
  updateListener(cam: THREE.Camera) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const p = cam.getWorldPosition(this.listenerPos);
    const f = cam.getWorldDirection(_v);
    const t = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.02); l.positionY.setTargetAtTime(p.y, t, 0.02); l.positionZ.setTargetAtTime(p.z, t, 0.02);
      l.forwardX.setTargetAtTime(f.x, t, 0.02); l.forwardY.setTargetAtTime(f.y, t, 0.02); l.forwardZ.setTargetAtTime(f.z, t, 0.02);
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    }
  }

  private far(pos: THREE.Vector3, max = 300) {
    return pos.distanceTo(this.listenerPos) > max;
  }

  /** Короткий шумовой всплеск через фильтр с огибающей. */
  private burst(pos: THREE.Vector3 | null, dur: number, f0: number, f1: number, type: BiquadFilterType, vol: number, q = 0.8) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = this.noiseSource();
    src.loop = false;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f).connect(g);
    if (pos) { const p = this.makePanner(8); this.placePanner(p, pos); g.connect(p).connect(this.sfx!); }
    else g.connect(this.sfx!);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  private tone(pos: THREE.Vector3 | null, type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g);
    if (pos) { const p = this.makePanner(8); this.placePanner(p, pos); g.connect(p).connect(this.sfx!); }
    else g.connect(this.sfx!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  gunshot(w: WeaponId, pos: THREE.Vector3) {
    if (!this.ctx || this.far(pos, 500)) return;
    const p: Record<string, [number, number, number]> = { pistol: [0.18, 2600, 0.9], smg: [0.12, 3200, 0.7], shotgun: [0.38, 1600, 1.2], rifle: [0.22, 2200, 1.0], fist: [0.05, 800, 0.2] };
    const [dur, f, v] = p[w] ?? p.pistol;
    this.burst(pos, dur, f, 300, 'lowpass', v, 1.2);
    this.tone(pos, 'sine', 160, 45, dur * 0.8, v * 0.6);
    // Эхо между домами.
    setTimeout(() => this.burst(pos, dur * 1.6, f * 0.4, 150, 'lowpass', v * 0.18), 90);
  }

  explosion(pos: THREE.Vector3) {
    if (!this.ctx) return;
    this.burst(pos, 1.8, 2400, 60, 'lowpass', 1.6, 0.5);
    this.tone(pos, 'sine', 70, 25, 1.2, 1.0);
    setTimeout(() => this.burst(pos, 1.4, 500, 50, 'lowpass', 0.35), 160);
  }

  impact(pos: THREE.Vector3, strength: number) {
    if (!this.ctx || this.far(pos, 150)) return;
    this.burst(pos, 0.25 + strength * 0.3, 1800, 200, 'lowpass', 0.4 + strength * 0.8, 1);
    this.tone(pos, 'triangle', 240 + Math.random() * 200, 120, 0.25, 0.25 * strength);
  }

  punch(pos: THREE.Vector3) {
    this.burst(pos, 0.09, 900, 150, 'lowpass', 0.7, 1);
    this.tone(pos, 'sine', 120, 60, 0.1, 0.5);
  }
  whoosh(pos: THREE.Vector3) {
    this.burst(pos, 0.18, 600, 2400, 'bandpass', 0.15, 2);
  }
  footstep(pos: THREE.Vector3, wet: number) {
    if (!this.ctx || this.far(pos, 30)) return;
    this.burst(pos, 0.05 + wet * 0.04, 1400 + wet * 1500, 300, 'lowpass', 0.09 + wet * 0.05, 1);
  }
  splash(pos: THREE.Vector3) {
    this.burst(pos, 0.6, 3000, 400, 'lowpass', 0.5, 0.7);
  }
  horn(pos: THREE.Vector3) {
    if (!this.ctx) return;
    this.tone(pos, 'square', 392, 392, 0.35, 0.08);
    this.tone(pos, 'square', 494, 494, 0.35, 0.06);
  }
  thunder() {
    if (!this.ctx) return;
    this.burst(null, 3.5, 700, 40, 'lowpass', 0.9, 0.4);
    setTimeout(() => this.burst(null, 2.5, 300, 40, 'lowpass', 0.6, 0.4), 400);
  }
  ui(kind: 'click' | 'ok' | 'error' | 'cash' | 'pass' | 'fail' | 'pickup' | 'phone') {
    if (!this.ctx) return;
    switch (kind) {
      case 'click': this.tone(null, 'triangle', 900, 700, 0.06, 0.08); break;
      case 'ok': this.tone(null, 'triangle', 660, 660, 0.1, 0.1); this.tone(null, 'triangle', 990, 990, 0.14, 0.1, 0.08); break;
      case 'error': this.tone(null, 'square', 220, 180, 0.2, 0.06); break;
      case 'cash': [1320, 1760, 2093].forEach((f, i) => this.tone(null, 'sine', f, f, 0.12, 0.08, i * 0.05)); break;
      case 'pickup': this.tone(null, 'sine', 880, 1760, 0.15, 0.1); break;
      case 'phone': [0, 0.3].forEach((d) => { this.tone(null, 'sine', 1200, 1200, 0.15, 0.06, d); this.tone(null, 'sine', 1500, 1500, 0.15, 0.05, d + 0.08); }); break;
      case 'pass': [523, 659, 784, 1047].forEach((f, i) => this.tone(null, 'triangle', f, f, 0.5, 0.12, i * 0.12)); break;
      case 'fail': [392, 330, 262].forEach((f, i) => this.tone(null, 'sawtooth', f, f * 0.98, 0.45, 0.06, i * 0.18)); break;
    }
  }

  setRain(k: number) {
    if (this.rainGain && this.ctx) this.rainGain.gain.setTargetAtTime(k * 0.22, this.ctx.currentTime, 0.5);
  }
  setHum(k: number) {
    if (this.humGain && this.ctx) this.humGain.gain.setTargetAtTime(k, this.ctx.currentTime, 0.5);
  }

  // ------------------------------------------------------------------ радио
  /** Переключить станцию (-1 — выкл). Возвращает название. */
  cycleRadio(): string {
    this.station = this.station + 1 >= STATIONS.length ? -1 : this.station + 1;
    this.setStation(this.station);
    return this.station < 0 ? 'Радио выключено' : STATIONS[this.station].name;
  }

  setStation(i: number) {
    this.station = i;
    if (!this.ctx) return;
    if (this.schedTimer !== null) { clearInterval(this.schedTimer); this.schedTimer = null; }
    if (i < 0) return;
    this.nextNote = this.ctx.currentTime + 0.1;
    this.step = 0;
    this.schedTimer = window.setInterval(() => this.schedule(), 40);
  }

  private schedule() {
    if (!this.ctx || this.station < 0) return;
    const st = STATIONS[this.station];
    const sixteenth = 60 / st.bpm / 4;
    while (this.nextNote < this.ctx.currentTime + 0.15) {
      this.playStep(st, this.step, this.nextNote, sixteenth);
      this.nextNote += sixteenth * (st.style === 'jazz' && this.step % 2 === 1 ? 0.8 : st.style === 'jazz' ? 1.2 : 1);
      this.step = (this.step + 1) % 128;
    }
  }

  private note(t: number, midi: number, dur: number, type: OscillatorType, vol: number, cutoff: number, detune = 0) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    o.detune.value = detune;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + Math.min(0.05, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(f).connect(g).connect(this.music!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private drum(t: number, kind: 'kick' | 'snare' | 'hat', vol: number) {
    const ctx = this.ctx!;
    if (kind === 'kick') {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(g).connect(this.music!);
      o.start(t); o.stop(t + 0.32);
      return;
    }
    const s = this.noiseSource();
    s.loop = false;
    const f = ctx.createBiquadFilter();
    f.type = kind === 'hat' ? 'highpass' : 'bandpass';
    f.frequency.value = kind === 'hat' ? 7000 : 1800;
    const g = ctx.createGain();
    const d = kind === 'hat' ? 0.04 : 0.16;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    s.connect(f).connect(g).connect(this.music!);
    s.start(t, Math.random());
    s.stop(t + d + 0.02);
  }

  private playStep(st: Station, step: number, t: number, sx: number) {
    const bar = Math.floor(step / 16) % st.chords.length;
    const chord = st.chords[bar];
    const s16 = step % 16;
    if (st.style === 'synth') {
      if (s16 % 4 === 0) this.drum(t, 'kick', 0.5);
      if (s16 === 4 || s16 === 12) this.drum(t, 'snare', 0.25);
      if (s16 % 2 === 0) this.drum(t, 'hat', 0.05);
      if (s16 % 2 === 0) this.note(t, chord[0] - 24 + (s16 % 4 === 2 ? 12 : 0), sx * 1.8, 'sawtooth', 0.09, 700);
      if (s16 === 0) for (const n of chord) { this.note(t, n, sx * 15, 'sawtooth', 0.025, 1800, -8); this.note(t, n, sx * 15, 'sawtooth', 0.025, 1800, 8); }
      if (s16 % 3 === 0) this.note(t, chord[(step >> 1) % chord.length] + 12, sx * 1.5, 'square', 0.02, 2500);
    } else if (st.style === 'lofi') {
      if (s16 === 0 || s16 === 10) this.drum(t, 'kick', 0.45);
      if (s16 === 4 || s16 === 12) this.drum(t, 'snare', 0.2);
      if (s16 % 2 === 0) this.drum(t, 'hat', 0.035);
      if (s16 === 0) for (const n of chord) this.note(t + Math.random() * 0.02, n, sx * 14, 'triangle', 0.045, 1400);
      if (s16 === 0 || s16 === 7) this.note(t, chord[0] - 24, sx * 5, 'sine', 0.16, 400);
      if (s16 === 8 && Math.random() < 0.6) this.note(t, chord[2] + 12, sx * 4, 'sine', 0.04, 3000);
    } else {
      if (s16 % 4 === 0) this.drum(t, 'hat', 0.05);
      if (s16 === 0 || s16 === 8) this.drum(t, 'kick', 0.18);
      if (s16 % 4 === 0) this.note(t, chord[(s16 / 4) % chord.length] - 24, sx * 3.6, 'sine', 0.15, 600);
      if (s16 === 2 || s16 === 10) for (const n of chord) this.note(t, n, sx * 3, 'triangle', 0.03, 1600);
      if (Math.random() < 0.3) this.note(t, chord[Math.floor(Math.random() * chord.length)] + 12, sx * 2, 'sine', 0.035, 2600);
    }
  }
}
