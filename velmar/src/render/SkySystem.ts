/**
 * Небо, солнце/луна, цикл дня и ночи, каскадные тени (CSM), карта окружения (PMREM).
 *
 * Время суток задаётся в часах [0..24). Солнце восходит на востоке (+X) и проходит
 * по южной части неба. Ночью основной направленный свет — луна.
 */
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { MaterialLib, SharedUniforms } from './Materials';
import type { QualityPreset } from '../core/Quality';
import { clamp, lerp, smoothstep } from '../core/MathUtil';

export interface WeatherInfluence {
  /** 0..1 — облачность. */
  clouds: number;
  /** 0..1 — интенсивность дождя. */
  rain: number;
  /** 0..1 — вспышка молнии. */
  lightning: number;
  /** Дополнительная плотность тумана (утренняя дымка, ливень). */
  fogBoost: number;
}

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();

export class SkySystem {
  readonly sky: Sky;
  private envSky: Sky;
  private envScene = new THREE.Scene();
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envTimer = 999;
  /** Перегенерировать окружение на ближайшем update (после расчёта положения солнца). */
  forceEnv = true;
  private envNight: THREE.Mesh;
  private lastEnvSun = new THREE.Vector3(0, -1, 0);
  private lastEnvRain = -1;
  readonly hemi: THREE.HemisphereLight;
  csm: CSM | null = null;
  private stars: THREE.Points;
  private moon: THREE.Mesh;
  private glow: THREE.Mesh;
  /** Направление на солнце (единичный вектор). */
  readonly sunDir = new THREE.Vector3();
  readonly moonDir = new THREE.Vector3();
  /** Направление основного света (откуда светит), для теней. */
  readonly lightDir = new THREE.Vector3();
  /** 0 — день, 1 — глубокая ночь. */
  night = 0;
  /** Высота солнца (синус угла). */
  sunHeight = 0;
  readonly fogColor = new THREE.Color();
  /** Экспозиция для тональной компрессии. */
  exposure = 0.6;
  weather: WeatherInfluence = { clouds: 0.3, rain: 0, lightning: 0, fogBoost: 0 };

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
  ) {
    this.sky = new Sky();
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    scene.add(this.sky);

    // Отдельная копия неба для генерации карты окружения (без звёзд и тумана).
    SkySystem.patchSkyShader(this.sky);
    this.envSky = new Sky();
    SkySystem.patchSkyShader(this.envSky);
    this.envSky.scale.setScalar(900);
    this.envSky.material.uniforms.showSunDisc.value = 0;
    this.envScene.add(this.envSky);

    // Ночная «подсветка» неба для отражений: тёмно-синий зенит и тёплая засветка города у горизонта.
    this.envNight = new THREE.Mesh(
      new THREE.SphereGeometry(800, 24, 12),
      new THREE.ShaderMaterial({
        uniforms: { uAmount: { value: 0 } },
        vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: /* glsl */ `uniform float uAmount; varying vec3 vDir;
          void main(){
            float h = vDir.y;
            vec3 zen = vec3(0.10, 0.14, 0.30);
            vec3 hor = vec3(0.32, 0.2, 0.12);
            vec3 gnd = vec3(0.12, 0.10, 0.09);
            vec3 c = h > 0.0 ? mix(hor, zen, pow(h, 0.5)) : mix(hor, gnd, min(-h * 4.0, 1.0));
            gl_FragColor = vec4(c * uAmount, 1.0);
          }`,
        side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending, transparent: true,
      }),
    );
    this.envScene.add(this.envNight);

    this.pmrem = new THREE.PMREMGenerator(renderer);

    this.hemi = new THREE.HemisphereLight(0x9fb8ff, 0x4a4038, 0.5);
    scene.add(this.hemi);

    // Звёзды: точки на сфере, проявляются ночью.
    const starGeo = new THREE.BufferGeometry();
    const N = 2200;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const y = Math.abs(u) * 0.95 + 0.05;
      pos[i * 3] = r * Math.cos(th);
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = r * Math.sin(th);
      const b = 0.4 + Math.random() * 0.6;
      const tint = Math.random();
      col[i * 3] = b * (tint > 0.8 ? 1.0 : 0.85);
      col[i * 3 + 1] = b * 0.9;
      col[i * 3 + 2] = b * (tint < 0.3 ? 1.0 : 0.85);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const starMat = new THREE.PointsMaterial({
      size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true,
      opacity: 0, depthWrite: false, fog: false,
    });
    this.stars = new THREE.Points(starGeo, starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -9;
    scene.add(this.stars);

    // Луна: диск с мягким свечением.
    const moonMat = new THREE.MeshBasicMaterial({ color: 0xdfe6ff, transparent: true, opacity: 0, fog: false, depthWrite: false });
    this.moon = new THREE.Mesh(new THREE.CircleGeometry(1, 32), moonMat);
    this.moon.frustumCulled = false;
    this.moon.renderOrder = -8;
    scene.add(this.moon);

    // Засветка горизонта ночью от огней города.
    const glowMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0.5, 0.28, 0.12) }, uAmount: { value: 0 } },
      vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `uniform vec3 uColor; uniform float uAmount; varying vec3 vDir;
        void main(){ float h = max(vDir.y, 0.0); float g = exp(-h * 9.0) * uAmount; gl_FragColor = vec4(uColor * g, g); }`,
      transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending, fog: false,
    });
    this.glow = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), glowMat);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = -7;
    scene.add(this.glow);

    scene.fog = new THREE.FogExp2(0x9fb0c0, 0.0012);
  }

  /**
   * acos() от компоненты чуть больше 1 даёт NaN в зените; при свёртке PMREM
   * NaN расползается по всей карте окружения. Зажимаем аргументы.
   */
  private static patchSkyShader(sky: Sky) {
    const m = sky.material;
    m.fragmentShader = m.fragmentShader
      .replace('acos( max( 0.0, direction.y ) )', 'acos( clamp( direction.y, 0.0, 1.0 ) )')
      .replace('acos( direction.y )', 'acos( clamp( direction.y, -1.0, 1.0 ) )')
      .replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( clamp(texColor, vec3(0.0), vec3(48.0)), 1.0 );');
    m.needsUpdate = true;
  }

  /** Создаёт (или пересоздаёт) каскадные тени под пресет качества. */
  setupShadows(preset: QualityPreset) {
    if (this.csm) {
      this.csm.remove();
      this.csm.dispose();
      this.csm = null;
    }
    this.renderer.shadowMap.enabled = preset.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: preset.cascades,
      maxFar: preset.shadowFar,
      mode: 'practical',
      shadowMapSize: preset.shadowMapSize,
      lightDirection: new THREE.Vector3(-1, -1, -1).normalize(),
      lightIntensity: 3,
      lightNear: 1,
      lightFar: 3000,
      lightMargin: 320,
      shadowBias: -0.00025,
    });
    this.csm.fade = preset.cascades > 1;
    for (const l of this.csm.lights) {
      l.shadow.normalBias = 0.06;
      l.shadow.radius = preset.name === 'high' ? 3 : 2;
      l.castShadow = true;
    }
    MaterialLib.setCSM(this.csm);
    this.csm.updateFrustums();
  }

  /** Вызывать при изменении параметров камеры (fov/near/far). */
  onCameraChanged() {
    this.csm?.updateFrustums();
  }

  /**
   * Пересчитывает положение светил, цвета, туман и карту окружения.
   * @param hours время суток
   */
  update(hours: number, dt: number, preset: QualityPreset) {
    const w = this.weather;
    // --- Солнце ---
    const dayT = (hours - 6) / 12; // 0 — восход, 1 — закат
    const az = dayT * Math.PI;
    const el = Math.sin(dayT * Math.PI) * THREE.MathUtils.degToRad(68);
    this.sunDir.set(Math.cos(az) * Math.cos(el), Math.sin(el), 0.45 * Math.cos(el)).normalize();
    this.sunHeight = this.sunDir.y;
    // --- Луна (ночью идёт по противоположной стороне) ---
    let nightT = (hours - 18) / 12;
    if (nightT < 0) nightT += 2;
    const mel = Math.sin(clamp(nightT, 0, 1) * Math.PI) * THREE.MathUtils.degToRad(55) + 0.05;
    const maz = nightT * Math.PI;
    this.moonDir.set(Math.cos(maz) * Math.cos(mel), Math.sin(mel), -0.35 * Math.cos(mel)).normalize();

    const sunUp = smoothstep(-0.12, 0.08, this.sunHeight);
    this.night = 1 - sunUp;
    SharedUniforms.uNight.value = smoothstep(0.25, 0.85, this.night);

    // --- Небо (Preetham + облака) ---
    const u = this.sky.material.uniforms;
    const turb = lerp(2.2, 9.0, Math.max(w.clouds * 0.6, w.rain));
    const ray = lerp(1.0, 2.6, 1 - smoothstep(0.0, 0.35, this.sunHeight)) * (1 - w.rain * 0.5);
    for (const uu of [u, this.envSky.material.uniforms]) {
      uu.sunPosition.value.copy(this.sunDir);
      uu.turbidity.value = turb;
      uu.rayleigh.value = ray;
      uu.mieCoefficient.value = lerp(0.004, 0.02, w.rain);
      uu.mieDirectionalG.value = 0.82;
      uu.cloudCoverage.value = lerp(0.25, 0.95, Math.max(w.clouds, w.rain));
      uu.cloudDensity.value = lerp(0.35, 0.9, w.rain);
      uu.cloudScale.value = 0.00022;
      uu.cloudSpeed.value = 0.00003;
      uu.time.value = SharedUniforms.uTime.value;
    }
    u.showSunDisc.value = 1 - w.rain;

    // Небо следует за камерой и вписывается в дальнюю плоскость.
    const far = this.camera.far;
    this.sky.position.copy(this.camera.position);
    this.sky.scale.setScalar(far * 1.0);
    this.stars.position.copy(this.camera.position);
    this.stars.scale.setScalar(far * 0.9);
    (this.stars.material as THREE.PointsMaterial).opacity = smoothstep(0.55, 0.95, this.night) * (1 - Math.max(w.clouds * 0.7, w.rain));
    this.glow.position.copy(this.camera.position);
    this.glow.scale.setScalar(far * 0.85);
    (this.glow.material as THREE.ShaderMaterial).uniforms.uAmount.value = 0.35 * smoothstep(0.4, 0.9, this.night) * (1 + w.rain);
    const mm = this.moon.material as THREE.MeshBasicMaterial;
    mm.opacity = smoothstep(0.4, 0.8, this.night) * (1 - w.rain * 0.9);
    this.moon.position.copy(this.camera.position).addScaledVector(this.moonDir, far * 0.8);
    this.moon.scale.setScalar(far * 0.8 * 0.022);
    this.moon.lookAt(this.camera.position);

    // --- Основной свет ---
    const sunI = 3.4 * smoothstep(-0.02, 0.18, this.sunHeight) * (1 - 0.75 * Math.max(w.rain, w.clouds * 0.5));
    const moonI = 0.32 * smoothstep(0.5, 0.9, this.night) * (1 - 0.7 * w.rain);
    const useSun = sunI >= moonI;
    this.lightDir.copy(useSun ? this.sunDir : this.moonDir);
    const lightCol = _c1;
    if (useSun) {
      // Тёплый свет у горизонта, белый днём.
      const t = smoothstep(0.0, 0.4, this.sunHeight);
      lightCol.setRGB(1.0, lerp(0.5, 0.96, t), lerp(0.28, 0.9, t));
    } else {
      lightCol.setRGB(0.55, 0.66, 1.0);
    }
    const intensity = (useSun ? sunI : moonI) + w.lightning * 6;
    if (w.lightning > 0) lightCol.lerp(_c2.setRGB(0.8, 0.85, 1), w.lightning);
    if (this.csm) {
      this.csm.lightDirection.copy(this.lightDir).negate();
      for (const l of this.csm.lights) {
        l.intensity = intensity;
        l.color.copy(lightCol);
      }
      this.csm.update();
    }

    // --- Рассеянный свет ---
    const dayK = sunUp;
    this.hemi.color.setRGB(lerp(0.12, 0.62, dayK), lerp(0.16, 0.74, dayK), lerp(0.3, 1.0, dayK));
    this.hemi.groundColor.setRGB(lerp(0.08, 0.36, dayK), lerp(0.06, 0.3, dayK), lerp(0.06, 0.24, dayK));
    this.hemi.intensity = lerp(0.35, 0.55, dayK) * (1 + w.rain * 0.3) + w.lightning * 2;
    // Небо Preetham в линейных единицах ~5–20, поэтому окружение нормируется,
    // чтобы соотношение солнце : небо было близко к реальному (~3:1).
    this.scene.environmentIntensity = 0.13 * (1 - 0.3 * w.rain) + w.lightning * 0.3;
    (this.envNight.material as THREE.ShaderMaterial).uniforms.uAmount.value = 0.9 * smoothstep(0.3, 0.9, this.night) * (1 + w.rain * 0.5);

    // --- Туман ---
    const dusk = 1 - Math.abs(this.sunHeight) / 0.35;
    const duskK = clamp(dusk, 0, 1) * sunUp;
    this.fogColor.setRGB(0.6, 0.7, 0.82);
    this.fogColor.lerp(_c2.setRGB(0.78, 0.55, 0.42), duskK * 0.8);
    this.fogColor.lerp(_c2.setRGB(0.035, 0.045, 0.075), this.night);
    this.fogColor.lerp(_c2.setRGB(0.42, 0.45, 0.5).multiplyScalar(lerp(0.15, 1, dayK)), w.rain * 0.8);
    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(this.fogColor);
    fog.density = 0.0007 + w.fogBoost * 0.003 + w.rain * 0.0026 + this.night * 0.0004;
    SharedUniforms.uFogSunDir.value.copy(this.sunDir);
    SharedUniforms.uFogSunColor.value.copy(lightCol).multiplyScalar(0.28 * sunUp * (1 - w.rain));
    SharedUniforms.uFogHeight.value = lerp(0.012, 0.006, w.rain);

    // Экспозиция: ночью чуть выше, чтобы читались тёмные улицы.
    this.exposure = lerp(1.05, 0.62, dayK) * (1 + w.rain * 0.15);

    // --- Карта окружения (дорогой шаг, делается редко) ---
    this.envTimer += dt;
    const moved = this.lastEnvSun.angleTo(this.sunDir) > 0.03 || Math.abs(this.lastEnvRain - w.rain) > 0.1;
    if (this.forceEnv || (this.envTimer > preset.envInterval && moved)) this.regenerateEnv();
  }

  /** Перерисовывает небо в PMREM — источник отражений и рассеянного света для PBR. */
  regenerateEnv() {
    this.forceEnv = false;
    this.envTimer = 0;
    this.lastEnvSun.copy(this.sunDir);
    this.lastEnvRain = this.weather.rain;
    const prev = this.envRT;
    this.envRT = this.pmrem.fromScene(this.envScene as unknown as THREE.Scene, 0, 0.1, 2000);
    this.scene.environment = this.envRT.texture;
    prev?.dispose();
  }
}
