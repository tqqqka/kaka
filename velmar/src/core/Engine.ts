/**
 * Ядро рендера: WebGL2-рендерер, сцена, камера, небо/свет, постобработка,
 * управление качеством и динамическим разрешением, сбор статистики кадра.
 */
import * as THREE from 'three';
import { SkySystem } from '../render/SkySystem';
import { PostFX } from '../render/PostFX';
import { FrameGovernor, PRESETS, type QualityName, type QualityPreset } from './Quality';
import { SharedUniforms } from '../render/Materials';

export interface FrameStats {
  calls: number;
  triangles: number;
  frameMs: number;
  fps: number;
  scale: number;
  preset: QualityName;
  geometries: number;
  textures: number;
  programs: number;
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sky: SkySystem;
  readonly post: PostFX;
  readonly governor: FrameGovernor;
  preset: QualityPreset;
  /** Пользовательский множитель разрешения (настройки). */
  userScale = 1;
  width = 1;
  height = 1;
  readonly stats: FrameStats = { calls: 0, triangles: 0, frameMs: 0, fps: 0, scale: 1, preset: 'medium', geometries: 0, textures: 0, programs: 0 };
  /** Колбэки, вызываемые при смене пресета (мир меняет дальность LOD и т.д.). */
  readonly presetListeners: ((p: QualityPreset) => void)[] = [];

  constructor(readonly canvas: HTMLCanvasElement, quality: QualityName) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      preserveDrawingBuffer: new URLSearchParams(location.search).has('shots'),
    });
    if (!this.renderer.capabilities.isWebGL2) throw new Error('Нужен WebGL2');
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.6;
    this.renderer.info.autoReset = false;
    this.renderer.setClearColor(0x000000, 1);

    this.preset = PRESETS[quality];
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.15, this.preset.farDistance);
    this.camera.position.set(0, 5, 10);
    this.scene.add(this.camera);

    this.sky = new SkySystem(this.renderer, this.scene, this.camera);
    this.post = new PostFX(this.renderer, this.scene, this.camera);
    this.governor = new FrameGovernor(
      () => this.applyPixelRatio(),
      (dir) => this.stepPreset(dir),
    );

    this.resize();
    this.applyPreset(quality);
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 200));
  }

  /** Полное применение пресета: тени, постобработка, дальность. */
  applyPreset(name: QualityName) {
    this.preset = PRESETS[name];
    this.stats.preset = name;
    this.camera.far = this.preset.farDistance;
    this.camera.updateProjectionMatrix();
    this.sky.setupShadows(this.preset);
    this.applyPixelRatio(true);
    this.post.setup(this.preset, this.width, this.height);
    this.sky.forceEnv = true;
    this.governor.reset();
    for (const l of this.presetListeners) l(this.preset);
  }

  private stepPreset(dir: -1 | 1) {
    const order: QualityName[] = ['low', 'medium', 'high'];
    const idx = order.indexOf(this.preset.name) + dir;
    if (idx < 0 || idx >= order.length) return;
    console.info('[quality] авто-переключение на', order[idx]);
    this.applyPreset(order[idx]);
  }

  /** Итоговый pixelRatio = min(DPR, предел пресета) × масштаб от FPS × пользовательский. */
  applyPixelRatio(skipPost = false) {
    const dpr = Math.min(window.devicePixelRatio || 1, this.preset.pixelRatioMax);
    const pr = Math.max(0.4, dpr * this.governor.scale * this.userScale);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.width, this.height, false);
    this.stats.scale = this.governor.scale * this.userScale;
    if (!skipPost) this.post.resize(this.width, this.height);
  }

  resize() {
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.applyPixelRatio();
    this.sky.onCameraChanged();
  }

  setFov(fov: number) {
    if (Math.abs(this.camera.fov - fov) < 0.01) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /** Рендер кадра. hours — игровое время суток. */
  render(dt: number, hours: number) {
    SharedUniforms.uTime.value += dt;
    this.renderer.info.reset();
    this.camera.updateMatrixWorld();
    this.sky.update(hours, dt, this.preset);
    this.renderer.toneMappingExposure = this.sky.exposure;
    this.post.setBloom(SharedUniforms.uNight.value, this.sky.weather.rain);
    this.post.render(dt);
    const info = this.renderer.info;
    this.stats.calls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.geometries = info.memory.geometries;
    this.stats.textures = info.memory.textures;
    this.stats.programs = info.programs?.length ?? 0;
    this.governor.update(dt);
    this.stats.frameMs = this.governor.frameMs;
    this.stats.fps = this.governor.fps;
  }
}
