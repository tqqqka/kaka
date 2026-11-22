/**
 * Пресеты качества графики, автоопределение по FPS и динамическое разрешение.
 */

export type QualityName = 'low' | 'medium' | 'high';

export interface QualityPreset {
  name: QualityName;
  /** Верхний предел devicePixelRatio. */
  pixelRatioMax: number;
  shadows: boolean;
  shadowMapSize: number;
  cascades: number;
  /** Дальность каскадных теней, м. */
  shadowFar: number;
  postFX: boolean;
  bloom: boolean;
  ao: boolean;
  msaa: number;
  fxaa: boolean;
  /** Радиус детальной геометрии (LOD0), м. */
  detailDistance: number;
  /** Дальняя плоскость камеры, м. */
  farDistance: number;
  pedCount: number;
  trafficCount: number;
  rainCount: number;
  /** Период обновления карты окружения неба, с. */
  envInterval: number;
  /** Реальный прожектор фар у машины игрока. */
  headlightSpot: boolean;
  propShadows: boolean;
}

export const PRESETS: Record<QualityName, QualityPreset> = {
  low: {
    name: 'low', pixelRatioMax: 1.0, shadows: true, shadowMapSize: 1024, cascades: 1, shadowFar: 70,
    postFX: false, bloom: false, ao: false, msaa: 0, fxaa: false,
    detailDistance: 220, farDistance: 850, pedCount: 12, trafficCount: 10, rainCount: 1500,
    envInterval: 8, headlightSpot: false, propShadows: false,
  },
  medium: {
    name: 'medium', pixelRatioMax: 1.5, shadows: true, shadowMapSize: 1024, cascades: 2, shadowFar: 140,
    postFX: true, bloom: true, ao: false, msaa: 0, fxaa: true,
    detailDistance: 300, farDistance: 1300, pedCount: 22, trafficCount: 16, rainCount: 3500,
    envInterval: 4, headlightSpot: true, propShadows: false,
  },
  high: {
    name: 'high', pixelRatioMax: 2.0, shadows: true, shadowMapSize: 2048, cascades: 3, shadowFar: 300,
    postFX: true, bloom: true, ao: true, msaa: 4, fxaa: false,
    detailDistance: 460, farDistance: 2200, pedCount: 34, trafficCount: 24, rainCount: 7000,
    envInterval: 2, headlightSpot: true, propShadows: true,
  },
};

/** Грубая начальная оценка класса устройства до замеров FPS. */
export function guessInitialQuality(): QualityName {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const mem = nav.deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  if (!mobile && cores >= 8) return 'high';
  if (mobile && (mem <= 3 || cores <= 4)) return 'low';
  return 'medium';
}

/**
 * Следит за временем кадра: плавно меняет масштаб разрешения рендера
 * и при длительной просадке/запасе переключает пресет.
 */
export class FrameGovernor {
  /** Текущий масштаб разрешения (умножается на базовый pixelRatio). */
  scale = 1;
  minScale = 0.55;
  maxScale = 1;
  dynamicEnabled = true;
  autoPreset = true;
  targetFps = 50;
  private samples: number[] = [];
  private sinceAdjust = 0;
  private lowStreak = 0;
  private highStreak = 0;
  /** Сглаженный FPS для HUD. */
  fps = 60;
  frameMs = 16.7;

  constructor(
    private onScaleChange: (s: number) => void,
    private onPresetChange: (dir: -1 | 1) => void,
  ) {}

  update(dt: number) {
    const ms = dt * 1000;
    this.frameMs += (ms - this.frameMs) * 0.05;
    this.fps = 1000 / this.frameMs;
    this.samples.push(ms);
    if (this.samples.length > 90) this.samples.shift();
    this.sinceAdjust += dt;
    if (this.sinceAdjust < 1.5 || this.samples.length < 45) return;
    this.sinceAdjust = 0;
    // Медиана устойчива к единичным фризам (сборка мусора, компиляция шейдеров).
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const fps = 1000 / median;
    const targetMs = 1000 / this.targetFps;
    if (this.dynamicEnabled) {
      if (median > targetMs * 1.15 && this.scale > this.minScale) {
        this.setScale(this.scale - 0.1);
      } else if (median < targetMs * 0.75 && this.scale < this.maxScale) {
        this.setScale(this.scale + 0.05);
      }
    }
    if (this.autoPreset) {
      if (fps < 24 && (this.scale <= this.minScale + 0.01 || !this.dynamicEnabled)) this.lowStreak++;
      else this.lowStreak = 0;
      if (fps > 58 && this.scale >= this.maxScale - 0.01) this.highStreak++;
      else this.highStreak = 0;
      if (this.lowStreak >= 3) {
        this.lowStreak = 0;
        this.onPresetChange(-1);
        this.setScale(0.85);
      } else if (this.highStreak >= 12) {
        this.highStreak = 0;
        this.onPresetChange(1);
      }
    }
  }

  setScale(s: number) {
    const ns = Math.max(this.minScale, Math.min(this.maxScale, Math.round(s * 100) / 100));
    if (ns !== this.scale) {
      this.scale = ns;
      this.onScaleChange(ns);
    }
  }

  reset() {
    this.samples.length = 0;
    this.lowStreak = this.highStreak = 0;
  }
}
