/**
 * Единый ввод: клавиатура/мышь, сенсорные контролы (пишут в этот же объект) и геймпад.
 * Игровая логика читает только абстрактные действия и оси.
 */

export type Action =
  | 'jump' | 'sprint' | 'fire' | 'aim' | 'melee' | 'reload' | 'cover' | 'enter' | 'interact'
  | 'nextWeapon' | 'prevWeapon' | 'handbrake' | 'horn' | 'gas' | 'brake' | 'up' | 'down'
  | 'yawL' | 'yawR' | 'map' | 'pause' | 'radio' | 'camera' | 'skip' | 'w1' | 'w2' | 'w3' | 'w4' | 'w5';

const KEYMAP: Record<string, Action> = {
  Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint', KeyV: 'melee', KeyR: 'reload', KeyC: 'cover',
  KeyF: 'enter', KeyE: 'interact', KeyH: 'horn', KeyM: 'map', Escape: 'pause', KeyP: 'pause', KeyN: 'radio',
  KeyT: 'camera', Enter: 'skip', Digit1: 'w1', Digit2: 'w2', Digit3: 'w3', Digit4: 'w4', Digit5: 'w5',
  KeyQ: 'yawL', ControlLeft: 'down', KeyX: 'down', Tab: 'nextWeapon',
};

export class Input {
  moveX = 0;
  moveY = 0;
  /** Накопленные за кадр смещения взгляда (в «пикселях»). */
  lookX = 0;
  lookY = 0;
  /** Аналоговые значения курков геймпада/педалей. */
  gasAxis = 0;
  brakeAxis = 0;
  private held = new Set<Action>();
  private pressedSet = new Set<Action>();
  private keys = new Set<string>();
  /** Ввод от сенсорного слоя (стик, кнопки). */
  touchMoveX = 0;
  touchMoveY = 0;
  private touchHeld = new Set<Action>();
  private padHeld = new Set<Action>();
  pointerLocked = false;
  sensitivity = 1;
  invertY = false;
  lastDevice: 'keyboard' | 'touch' | 'gamepad' = 'keyboard';
  enabled = true;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'Tab') e.preventDefault();
      this.keys.add(e.code);
      const a = KEYMAP[e.code];
      if (a) this.press(a);
      this.lastDevice = 'keyboard';
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      const a = KEYMAP[e.code];
      if (a) this.held.delete(a);
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.held.clear(); });
    canvas.addEventListener('mousedown', (e) => {
      if (this.lastDevice === 'touch') return;
      if (!this.pointerLocked && this.enabled) {
        // Pointer Lock необязателен (в некоторых окнах запрещён) — отказ просто игнорируем.
        try { const r = canvas.requestPointerLock?.() as unknown as Promise<void> | undefined; r?.catch?.(() => {}); } catch { /* недоступно */ }
      }
      if (e.button === 0) this.press('fire');
      if (e.button === 2) this.press('aim');
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.held.delete('fire');
      if (e.button === 2) this.held.delete('aim');
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.lookX += e.movementX * 0.12 * this.sensitivity;
      this.lookY += e.movementY * 0.12 * this.sensitivity * (this.invertY ? -1 : 1);
    });
    window.addEventListener('wheel', (e) => this.press(e.deltaY > 0 ? 'nextWeapon' : 'prevWeapon', true), { passive: true });
    document.addEventListener('pointerlockchange', () => { this.pointerLocked = document.pointerLockElement === canvas; });
  }

  private press(a: Action, momentary = false) {
    if (!this.held.has(a)) this.pressedSet.add(a);
    if (!momentary) this.held.add(a);
  }

  /** Нажатие от сенсорной кнопки. */
  touchDown(a: Action) {
    if (!this.touchHeld.has(a)) this.pressedSet.add(a);
    this.touchHeld.add(a);
    this.lastDevice = 'touch';
  }
  touchUp(a: Action) {
    this.touchHeld.delete(a);
  }
  touchLook(dx: number, dy: number) {
    this.lookX += dx * 0.25 * this.sensitivity;
    this.lookY += dy * 0.25 * this.sensitivity * (this.invertY ? -1 : 1);
    this.lastDevice = 'touch';
  }

  isHeld(a: Action): boolean {
    if (!this.enabled) return false;
    return this.held.has(a) || this.touchHeld.has(a) || this.padHeld.has(a);
  }
  pressed(a: Action): boolean {
    if (!this.enabled) return false;
    return this.pressedSet.has(a);
  }
  /** «Съесть» нажатие, чтобы его не обработал кто-то ещё. */
  consume(a: Action) {
    this.pressedSet.delete(a);
  }

  /** Опрос клавиатуры и геймпада в начале кадра. */
  poll() {
    let mx = 0, my = 0;
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) my += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) my -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    mx += this.touchMoveX;
    my += this.touchMoveY;
    this.gasAxis = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    this.brakeAxis = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    if (this.touchHeld.has('gas')) this.gasAxis = 1;
    if (this.touchHeld.has('brake')) this.brakeAxis = 1;
    if (k.has('KeyE')) this.held.add('yawR'); else this.held.delete('yawR');
    this.pollGamepad((x, y) => { mx += x; my += y; });
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    this.moveX = this.enabled ? mx : 0;
    this.moveY = this.enabled ? my : 0;
  }

  private padPrev = new Set<Action>();
  private pollGamepad(addMove: (x: number, y: number) => void) {
    const pads = navigator.getGamepads?.() ?? [];
    const gp = Array.from(pads).find((p) => p && p.connected);
    this.padHeld.clear();
    if (!gp) return;
    const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
    const lx = dz(gp.axes[0] ?? 0), ly = dz(gp.axes[1] ?? 0);
    const rx = dz(gp.axes[2] ?? 0), ry = dz(gp.axes[3] ?? 0);
    if (lx || ly || rx || ry) this.lastDevice = 'gamepad';
    addMove(lx, -ly);
    this.lookX += rx * 9 * this.sensitivity;
    this.lookY += ry * 7 * this.sensitivity * (this.invertY ? -1 : 1);
    const b = (i: number) => !!gp.buttons[i]?.pressed;
    const val = (i: number) => gp.buttons[i]?.value ?? 0;
    const map: [number, Action][] = [
      [0, 'jump'], [1, 'melee'], [2, 'reload'], [3, 'enter'], [4, 'prevWeapon'], [5, 'nextWeapon'],
      [6, 'aim'], [7, 'fire'], [8, 'map'], [9, 'pause'], [10, 'sprint'], [11, 'cover'], [12, 'interact'], [13, 'horn'], [14, 'radio'], [15, 'camera'],
    ];
    for (const [i, a] of map) if (b(i)) this.padHeld.add(a);
    if (this.padHeld.size) this.lastDevice = 'gamepad';
    this.gasAxis = Math.max(this.gasAxis, val(7));
    this.brakeAxis = Math.max(this.brakeAxis, val(6));
    if (b(0)) this.padHeld.add('handbrake');
    if (b(0)) this.padHeld.add('up');
    if (b(1)) this.padHeld.add('down');
    for (const a of this.padHeld) if (!this.padPrev.has(a)) this.pressedSet.add(a);
    this.padPrev = new Set(this.padHeld);
  }

  /** Конец кадра: сброс одноразовых нажатий и смещений взгляда. */
  endFrame() {
    this.pressedSet.clear();
    this.lookX = 0;
    this.lookY = 0;
  }

  releaseAll() {
    this.held.clear();
    this.touchHeld.clear();
    this.pressedSet.clear();
    this.touchMoveX = this.touchMoveY = 0;
  }

  hasKey(code: string) {
    return this.keys.has(code);
  }
}
