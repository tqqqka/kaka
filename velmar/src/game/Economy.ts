/**
 * Экономика: деньги, статистика, апгрейды машин игрока (хранятся в сохранении).
 */
import type { Game } from './Game';

export interface Stats {
  kills: number;
  copsKilled: number;
  carsStolen: number;
  carsDestroyed: number;
  distance: number;
  moneyEarned: number;
  deaths: number;
  arrests: number;
  taxiFares: number;
  racesWon: number;
  packages: number;
  playTime: number;
}

export class Economy {
  money = 500;
  stats: Stats = { kills: 0, copsKilled: 0, carsStolen: 0, carsDestroyed: 0, distance: 0, moneyEarned: 0, deaths: 0, arrests: 0, taxiFares: 0, racesWon: 0, packages: 0, playTime: 0 };

  constructor(private game: Game) {}

  add(amount: number, reason = '') {
    this.money += amount;
    if (amount > 0) this.stats.moneyEarned += amount;
    this.game.events.emit('money', { amount, reason });
    if (amount > 0) this.game.audio.ui('cash');
  }

  /** Списать деньги, если хватает. */
  spend(amount: number): boolean {
    if (this.money < amount) {
      this.game.audio.ui('error');
      this.game.hud.toast('Не хватает денег', 'bad');
      return false;
    }
    this.money -= amount;
    this.game.audio.ui('cash');
    return true;
  }
}
