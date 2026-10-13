// Проверка лога «хватает ли данных» и счётчик фигур тестового пака (синтетика).
import { describe, expect, it } from 'vitest';
import { checkLog } from '../src/analysis/logcheck';
import { countManeuvers } from '../src/analysis/maneuvers';

function ctx(fs: number, seconds: number, thr: (t: number) => number, sp: ((t: number) => number)[]): any {
  const n = Math.round(fs * seconds);
  const cols: Float64Array[] = [];
  const index: Record<string, number> = {};
  sp.forEach((f, a) => {
    const c = new Float64Array(n);
    for (let i = 0; i < n; i++) c[i] = f(i / fs);
    index[`setpoint[${a}]`] = cols.push(c) - 1;
    const g = Float64Array.from(c);
    index[`gyroADC[${a}]`] = cols.push(g) - 1;
  });
  const thrPct = new Float32Array(n), motorAvg = new Float32Array(n);
  for (let i = 0; i < n; i++) { thrPct[i] = thr(i / fs); motorAvg[i] = 0.2 + thrPct[i] / 200; }
  return { n, fs, thrPct, motorAvg, hasGyroUnfilt: true, log: { cols, index } };
}

describe('тестовый пак', () => {
  // 20 с: две плавные протяжки газа (по 4 с), 12 снапов по ролу (импульс 0.3 с до 600 °/с)
  const snap = (t: number): number => { const k = t % 1.5; return t > 8 && t < 26 && k < 0.3 ? 600 * Math.sin((Math.PI * k) / 0.3) : 0; };
  const thr = (t: number): number => (t < 4 ? 20 + t * 18 : t < 5 ? 20 : t < 9 ? 20 + (t - 5) * 18 : 45);
  const c = ctx(2000, 30, thr, [snap, () => 0, () => 0]);
  const mask = new Uint8Array(c.n).fill(1);

  it('считает протяжки газа и снапы', () => {
    const m = countManeuvers(c, mask);
    expect(m.sweeps).toBe(2);
    expect(m.snaps![0]).toBeGreaterThanOrEqual(10);
    expect(m.snaps![1]).toBe(0);
  });

  it('вердикт: фильтры можно, PID — долетать снапы по питчу', () => {
    const lc = checkLog(c, countManeuvers(c, mask), 92);
    expect(lc.filters.ok).toBe(true);
    expect(lc.pid.ok).toBe(false);
    expect(lc.pid.items.find((x) => x.id === 'snapsPitch')!.ok).toBe(false);
    expect(lc.bench).toBe(false);
  });

  it('редкий лог — фильтры не оценить', () => {
    const lc = checkLog({ ...c, fs: 1000 }, countManeuvers(c, mask), 92);
    expect(lc.filters.ok).toBe(false);
  });
});
