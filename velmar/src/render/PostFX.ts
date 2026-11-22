/**
 * Постобработка: HDR-рендер → GTAO (SSAO) → Bloom → тональная компрессия ACES + sRGB → FXAA.
 * На пресете Low композитор отключается полностью: рендер идёт прямо в экран.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import type { QualityPreset } from '../core/Quality';

export class PostFX {
  composer: EffectComposer | null = null;
  bloom: UnrealBloomPass | null = null;
  gtao: GTAOPass | null = null;
  fxaa: FXAAPass | null = null;
  enabled = false;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
  ) {}

  setup(preset: QualityPreset, width: number, height: number) {
    this.dispose();
    this.enabled = preset.postFX;
    if (!preset.postFX) return;
    const pr = this.renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(width * pr, height * pr, {
      type: THREE.HalfFloatType,
      samples: preset.msaa,
    });
    const composer = new EffectComposer(this.renderer, rt);
    composer.addPass(new RenderPass(this.scene, this.camera));
    if (preset.ao) {
      const gtao = new GTAOPass(this.scene, this.camera, Math.round(width / 2), Math.round(height / 2));
      gtao.output = GTAOPass.OUTPUT.Default;
      // AO в половинном разрешении: нормали/глубина и сам GTAO в 4 раза дешевле.
      const setSize = gtao.setSize.bind(gtao);
      gtao.setSize = (w: number, h: number) => setSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
      gtao.blendIntensity = 0.85;
      gtao.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1.4, thickness: 2.0, scale: 1.0, samples: 12 });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
      composer.addPass(gtao);
      this.gtao = gtao;
    }
    if (preset.bloom) {
      const bloom = new UnrealBloomPass(new THREE.Vector2(width / 2, height / 2), 0.55, 0.55, 0.92);
      composer.addPass(bloom);
      this.bloom = bloom;
    }
    composer.addPass(new OutputPass());
    if (preset.fxaa) {
      this.fxaa = new FXAAPass();
      composer.addPass(this.fxaa);
    }
    this.composer = composer;
    this.resize(width, height);
  }

  /** Сила свечения: ночью ярче, чтобы неон и окна «горели». */
  setBloom(night: number, rain: number) {
    if (!this.bloom) return;
    // Порог в линейных HDR-единицах: днём светится только солнце/блики, ночью — огни.
    this.bloom.strength = 0.18 + night * 0.3 + rain * 0.08;
    this.bloom.threshold = 2.4 - night * 0.9;
    this.bloom.radius = 0.4;
  }

  resize(width: number, height: number) {
    if (!this.composer) return;
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
  }

  render(dt: number) {
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.composer) {
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
      for (const p of this.composer.passes) (p as { dispose?: () => void }).dispose?.();
    }
    this.composer = null;
    this.bloom = null;
    this.gtao = null;
    this.fxaa = null;
  }
}
