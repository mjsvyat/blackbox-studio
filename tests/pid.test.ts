// Этап 4: step response и PID. Синтетика — система с известной переходной
// характеристикой; порт simplified_tuning.c — против заголовков настоящих логов.
import { describe, expect, it } from 'vitest';
import cfg from '../src/config/analysis.json';
import { buildContext } from '../src/analysis/context';
import { buildFlightMask } from '../src/analysis/flightMask';
import { decodeLog } from '../src/decoder/decoder';
import { scanFile } from '../src/decoder/scan';
import { analyzePid } from '../src/pid/analyze';
import { gainsFromHeader, simplifiedFromHeader, simplifiedPids } from '../src/pid/gains';
import { stepMetrics, stepResponse } from '../src/pid/stepResponse';
import { BIG_DUMP, SMALL_DUMP, fileReader, hasFixture, readRange } from './helpers';

const HAS_SMALL = hasFixture(SMALL_DUMP);
const HAS_BIG = hasFixture(BIG_DUMP);

function rng(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** замкнутый контур 2-го порядка + задержка; вход — «пилотские» ступеньки через PT3 40 Гц */
function plant(zeta: number, fn: number, delayMs: number, fs: number) {
  const sub = 8, dt = 1 / (fs * sub), wn = 2 * Math.PI * fn;
  const dN = Math.round(delayMs / 1000 / dt);
  let y = 0, v = 0;
  const hist: number[] = new Array(dN + 1).fill(0);
  return (u: number): number => {
    for (let s = 0; s < sub; s++) {
      hist.push(u);
      const ud = hist.shift()!;
      const acc = wn * wn * (ud - y) - 2 * zeta * wn * v;
      v += acc * dt;
      y += v * dt;
    }
    return y;
  };
}

function synth(fs: number, secs: number, zeta: number, fn: number, delayMs: number, noise: number, seed = 1) {
  const r = rng(seed), n = Math.round(fs * secs);
  const sp = new Float32Array(n), gy = new Float32Array(n);
  const k = 1 - Math.exp((-2 * Math.PI * 40 * 1.96) / fs);
  const p = plant(zeta, fn, delayMs, fs);
  let target = 0, next = 0, a1 = 0, a2 = 0, a3 = 0;
  for (let i = 0; i < n; i++) {
    if (i >= next) { target = r() < 0.3 ? 0 : (r() * 2 - 1) * 600; next = i + Math.round(fs * (0.1 + r() * 0.5)); }
    a1 += k * (target - a1); a2 += k * (a1 - a2); a3 += k * (a2 - a3);
    sp[i] = Math.round(a3);
    gy[i] = Math.round(p(a3) + (r() * 2 - 1) * noise * 1.7);
  }
  return { sp, gy };
}

/** истинная переходная характеристика той же системы */
function trueStep(zeta: number, fn: number, delayMs: number, fs: number) {
  const p = plant(zeta, fn, delayMs, fs);
  const R = Math.round(0.5 * fs);
  const t = new Float32Array(R), mean = new Float32Array(R);
  for (let i = 0; i < R; i++) { t[i] = i / fs; mean[i] = p(1); }
  return stepMetrics({ t, mean });
}

describe('step response на синтетике', () => {
  const fs = 2000;
  for (const [zeta, fn, d] of [[0.3, 20, 2], [0.4, 12, 3], [0.6, 15, 5], [0.8, 10, 4], [1.0, 12, 4]]) {
    it(`ζ=${zeta}, ${fn} Гц, задержка ${d} мс`, () => {
      const { sp, gy } = synth(fs, 60, zeta, fn, d, 3);
      const use = new Uint8Array(sp.length).fill(1);
      const r = stepResponse(sp, gy, use, fs, cfg.pid)!;
      const m = stepMetrics(r);
      const want = trueStep(zeta, fn, d, fs);
      expect(Math.abs(m.overshootPct - want.overshootPct)).toBeLessThan(4);
      expect(Math.abs(m.delayMs - want.delayMs)).toBeLessThan(3);
      expect(Math.abs(m.settle - 1)).toBeLessThan(0.02);
      expect(r.activeS).toBeGreaterThan(50);
    });
  }

  // дыры через каждые 2.5 с (14 % кадров) — жёстче, чем в реальных логах; смещение на
  // краях кусков (вход до начала куска не виден) даёт до ~5 п.п.
  it('дыры в маске не ломают оценку', () => {
    const { sp, gy } = synth(fs, 60, 0.5, 14, 3, 3, 7);
    const use = new Uint8Array(sp.length).fill(1);
    for (let i = 0; i < use.length; i += 5000) use.fill(0, i, i + 700);
    const m = stepMetrics(stepResponse(sp, gy, use, fs, cfg.pid)!);
    expect(Math.abs(m.overshootPct - trueStep(0.5, 14, 3, fs).overshootPct)).toBeLessThan(5);
  });
});

async function open(file: string, index: number) {
  const r = fileReader(file);
  const st = await scanFile(r);
  r.close();
  const L = st.logs.find((l) => l.index === index)!;
  const end = L.crossesWrap && L.wrapBoundary ? L.wrapBoundary : L.end;
  const c = buildContext(decodeLog(readRange(file, L.start, end - L.start)));
  return { c, fm: buildFlightMask(c) };
}

describe.skipIf(!HAS_SMALL)('PID на логе 2026.6.1', () => {
  it('Simplified (d_max) воспроизводит PID из заголовка', async () => {
    const { c } = await open(SMALL_DUMP, 4);
    const H = c.log.header;
    const g = gainsFromHeader(H);
    const s = simplifiedFromHeader(H)!;
    expect(s.dExtraName).toBe('simplified_d_max_gain');
    const calc = simplifiedPids(s.s, 'd_max', g);
    expect(calc.P).toEqual(g.P);
    expect(calc.I).toEqual(g.I);
    expect(calc.D).toEqual(g.D);
    expect(calc.F).toEqual(g.F);
    expect(calc.dExtra).toEqual(g.dExtra);
  });

  it('№4: 12 с движения стиков — оценке не доверяем', async () => {
    const { c, fm } = await open(SMALL_DUMP, 4);
    const p = analyzePid(c, fm.mask);
    for (const a of p.axes) expect(a.enough).toBe(false);
  });
});

describe.skipIf(!HAS_BIG)('PID на логах 4.5.2', () => {
  it('Simplified (d_min) воспроизводит PID из заголовка (master 115, PI 110, pitch PI 115…)', async () => {
    const { c } = await open(BIG_DUMP, 3);
    const H = c.log.header;
    const g = gainsFromHeader(H);
    const s = simplifiedFromHeader(H)!;
    expect(s.dExtraName).toBe('simplified_dmax_gain');
    const calc = simplifiedPids(s.s, 'd_min', g);
    expect(calc.P).toEqual([56, 68, 56]);
    expect([calc.P, calc.I, calc.D, calc.F, calc.dExtra]).toEqual([g.P, g.I, g.D, g.F, g.dExtra]);
  });

  it('№3 (149 с, флипы): ответ надёжный, гироскоп догоняет setpoint', async () => {
    const { c, fm } = await open(BIG_DUMP, 3);
    const p = analyzePid(c, fm.mask);
    for (const a of p.axes) {
      expect(a.enough).toBe(true);
      expect(Math.abs(a.metrics!.settle - 1)).toBeLessThan(0.06);
      expect(a.metrics!.overshootPct).toBeLessThan(20);
    }
    // трекинг хороший: ошибка — малая доля setpoint
    expect(p.axes[0].trackRms / p.axes[0].spRms).toBeLessThan(0.15);
  });
});
