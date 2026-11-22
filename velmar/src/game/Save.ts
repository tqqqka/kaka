/**
 * Сохранения и настройки: Capacitor Preferences (на Android — SharedPreferences,
 * в браузере — localStorage). При недоступности плагина — прямой localStorage.
 */
import { Preferences } from '@capacitor/preferences';
import type { WeaponId } from '../entities/Weapons';
import type { Stats } from './Economy';
import type { QualityName } from '../core/Quality';

export interface SaveData {
  v: 1;
  savedAt: number;
  hours: number;
  money: number;
  health: number;
  armor: number;
  pos: [number, number];
  owned: WeaponId[];
  ammo: Partial<Record<WeaponId, { mag: number; reserve: number }>>;
  storyIndex: number;
  completed: string[];
  packages: number[];
  stats: Stats;
  garage: { kind: string; paint: number; upgrades: { engine: number; brakes: number; armor: number } } | null;
}

export interface ControlLayout { [id: string]: { x: number; y: number; s: number } }

export interface Settings {
  quality: 'auto' | QualityName;
  renderScale: number;
  dynamicRes: boolean;
  sensitivity: number;
  invertY: boolean;
  master: number;
  music: number;
  sfx: number;
  showFps: boolean;
  autoAim: boolean;
  timeScale: number;
  layout: ControlLayout;
  buttonOpacity: number;
  buttonScale: number;
  vibration: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'auto', renderScale: 1, dynamicRes: true, sensitivity: 1, invertY: false,
  master: 0.8, music: 0.45, sfx: 0.9, showFps: false, autoAim: true, timeScale: 1,
  layout: {}, buttonOpacity: 0.75, buttonScale: 1, vibration: true,
};

const KEY_SAVE = 'velmar.save.v1';
const KEY_SETTINGS = 'velmar.settings.v1';

async function getItem(key: string): Promise<string | null> {
  try {
    const r = await Preferences.get({ key });
    return r.value;
  } catch {
    try { return localStorage.getItem(key); } catch { return null; }
  }
}

async function setItem(key: string, value: string) {
  try {
    await Preferences.set({ key, value });
  } catch {
    try { localStorage.setItem(key, value); } catch { /* приватный режим */ }
  }
}

export const Storage = {
  async loadSave(): Promise<SaveData | null> {
    const s = await getItem(KEY_SAVE);
    if (!s) return null;
    try {
      const d = JSON.parse(s) as SaveData;
      return d.v === 1 ? d : null;
    } catch { return null; }
  },
  async writeSave(d: SaveData) {
    await setItem(KEY_SAVE, JSON.stringify(d));
  },
  async deleteSave() {
    try { await Preferences.remove({ key: KEY_SAVE }); } catch { try { localStorage.removeItem(KEY_SAVE); } catch { /* */ } }
  },
  async loadSettings(): Promise<Settings> {
    const s = await getItem(KEY_SETTINGS);
    if (!s) return { ...DEFAULT_SETTINGS };
    try { return { ...DEFAULT_SETTINGS, ...(JSON.parse(s) as Partial<Settings>) }; } catch { return { ...DEFAULT_SETTINGS }; }
  },
  async writeSettings(s: Settings) {
    await setItem(KEY_SETTINGS, JSON.stringify(s));
  },
};
