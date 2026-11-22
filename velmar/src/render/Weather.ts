/**
 * Погода: смена состояний (ясно → облачно → дождь → гроза), капли дождя (инстансы-штрихи
 * вокруг камеры, анимация в вершинном шейдере), мокрые поверхности, молнии и гром,
 * утренний туман. Отражения огней на мокром асфальте — вытянутые блики.
 */
import * as THREE from 'three';
import { SharedUniforms } from './Materials';
import { damp, smoothstep } from '../core/MathUtil';
import type { Game } from '../game/Game';

export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog';

const BOX = new THREE.Vector3(46, 26, 46);

export class Weather {
  kind: WeatherKind = 'clear';
  rain = 0;
  clouds = 0.3;
  /** Мокрость (растёт под дождём, сохнет после). */
  wet = 0;
  lightning = 0;
  private nextChange = 240;
  private nextBolt = 10;
  private mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  /** Принудительная погода (миссии, настройки). */
  locked: WeatherKind | null = null;
  timeInState = 0;

  constructor(private game: Game, count: number) {
    const plane = new THREE.PlaneGeometry(0.018, 0.75);
    plane.translate(0, -0.37, 0);
    // Инстансинг без матриц: позиция капли считается в шейдере из сида.
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = plane.index;
    this.geo.setAttribute('position', plane.getAttribute('position'));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: SharedUniforms.uTime, uCam: { value: new THREE.Vector3() }, uBox: { value: BOX }, uAmount: { value: 0 }, uWind: { value: new THREE.Vector2(1.5, 0.6) }, uColor: { value: new THREE.Color(0.7, 0.75, 0.85) } },
      vertexShader: /* glsl */ `
        uniform float uTime; uniform vec3 uCam; uniform vec3 uBox; uniform float uAmount; uniform vec2 uWind;
        attribute vec4 aSeed; varying float vA;
        void main() {
          // Каждая капля зациклена в коробке вокруг камеры.
          vec3 p = aSeed.xyz * uBox;
          p.y -= uTime * (16.0 + aSeed.w * 6.0);
          p.xz += uWind * uTime * 0.6;
          vec3 base = uCam - uBox * 0.5;
          p = mod(p - base, uBox) + base;
          // Штрих ориентирован по скорости, повёрнут к камере.
          vec3 vel = normalize(vec3(uWind.x * 0.06, -1.0, uWind.y * 0.06));
          vec3 toCam = normalize(uCam - p);
          vec3 side = normalize(cross(vel, toCam));
          vec3 wp = p + side * position.x + vel * -position.y * (1.0 + aSeed.w);
          vA = step(aSeed.w, uAmount) * 0.55;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; varying float vA;
        void main() { if (vA < 0.01) discard; gl_FragColor = vec4(uColor, vA); }`,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 30;
    this.setCount(count);
    game.engine.scene.add(this.mesh);
  }

  setCount(count: number) {
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      seeds[i * 4] = Math.random(); seeds[i * 4 + 1] = Math.random(); seeds[i * 4 + 2] = Math.random(); seeds[i * 4 + 3] = Math.random();
    }
    this.geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    this.geo.instanceCount = count;
  }

  set(kind: WeatherKind) {
    this.kind = kind;
    this.timeInState = 0;
  }

  update(dt: number, hours: number) {
    const g = this.game;
    this.timeInState += dt;
    if (!this.locked) {
      this.nextChange -= dt;
      if (this.nextChange <= 0) {
        const r = Math.random();
        this.kind = r < 0.45 ? 'clear' : r < 0.7 ? 'cloudy' : r < 0.9 ? 'rain' : 'storm';
        this.nextChange = 180 + Math.random() * 240;
        this.timeInState = 0;
      }
    } else this.kind = this.locked;
    const k = this.kind;
    const targetRain = k === 'rain' ? 0.7 : k === 'storm' ? 1 : 0;
    const targetClouds = k === 'clear' ? 0.25 : k === 'cloudy' ? 0.7 : k === 'fog' ? 0.6 : 0.95;
    this.rain = damp(this.rain, targetRain, 0.25, dt);
    this.clouds = damp(this.clouds, targetClouds, 0.2, dt);
    this.wet = this.rain > 0.1 ? Math.min(1, this.wet + dt * 0.08) : Math.max(0, this.wet - dt * 0.008);
    SharedUniforms.uWetness.value = smoothstep(0, 1, this.wet);
    // Молнии в грозу.
    this.lightning = damp(this.lightning, 0, 9, dt);
    if (k === 'storm' && this.rain > 0.6) {
      this.nextBolt -= dt;
      if (this.nextBolt <= 0) {
        this.lightning = 1;
        this.nextBolt = 6 + Math.random() * 14;
        setTimeout(() => g.audio.thunder(), 600 + Math.random() * 2000);
      }
    }
    // Утренняя дымка.
    const morning = hours > 4.5 && hours < 8.5 ? 1 - Math.abs(hours - 6.5) / 2 : 0;
    const fogBoost = (k === 'fog' ? 0.8 : 0) + morning * 0.35;
    const sky = g.engine.sky.weather;
    sky.rain = this.rain;
    sky.clouds = this.clouds;
    sky.lightning = this.lightning;
    sky.fogBoost = fogBoost;
    // Капли.
    const cam = g.engine.camera.position;
    this.mat.uniforms.uCam.value.copy(cam);
    this.mat.uniforms.uAmount.value = this.rain;
    this.mesh.visible = this.rain > 0.02 && !(cam.y > 300);
    const night = g.engine.sky.night;
    (this.mat.uniforms.uColor.value as THREE.Color).setRGB(0.6 - night * 0.35, 0.65 - night * 0.35, 0.75 - night * 0.35);
    g.audio.setRain(this.rain);
  }
}
