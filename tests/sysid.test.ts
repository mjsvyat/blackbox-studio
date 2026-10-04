// Этап 7: модель оси и прогноз PID. Главная проверка честности — синтетика: «полёт»
// с известным объектом и регулятором (BF-подобным), шумом и возмущениями; модель
// идентифицируется тем же кодом, прогноз для других PID сравнивается с ИСТИННЫМ откликом.
import { describe, expect, it } from 'vitest';
import cfg from '../src/config/analysis.json';
import { buildContext } from '../src/analysis/context';
import { adviseLog, analyzeLog } from '../src/analysis/pipeline';
import { decodeLog } from '../src/decoder/decoder';
import { scanFile } from '../src/decoder/scan';
import { stepMetrics, stepResponse } from '../src/pid/stepResponse';
import { SAME, decimate, identifyAxis } from '../src/sysid/axisModel';
import { forecastAxis } from '../src/sysid/predict';
import { BIG_DUMP, SMALL_DUMP, fileReader, hasFixture, readRange } from './helpers';

function rng(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

interface Truth { tau: number; delay: number; K: number; kp: number; ki: number; kd: number; kf: number; fD: number }

/** «полёт» 2 кГц: стики → setpoint (PT3 40 Гц), регулятор BF-вида, моторы, корпус, ветер */
function flight(T: Truth, secs: number, seed = 3) {
  const fs = 2000, Ts = 1 / fs, n = secs * fs, r = rng(seed);
  const o = { sp: new Float32Array(n), gy: new Float32Array(n), P: new Float32Array(n), I: new Float32Array(n), D: new Float32Array(n), F: new Float32Array(n) };
  const kSp = 1 - Math.exp(-2 * Math.PI * 40 * 1.96 * Ts), kD = 1 - Math.exp(-2 * Math.PI * T.fD * Ts), kF = 1 - Math.exp(-2 * Math.PI * 30 * Ts);
  const dN = Math.round(T.delay * fs), am = Math.exp(-Ts / T.tau);
  const hist: number[] = new Array(dN + 1).fill(0);
  let tgt = 0, next = 0, a1 = 0, a2 = 0, a3 = 0, w = 0, acc = 0, I = 0, wd = 0, prevWd = 0, fsm = 0, prevSp = 0, wind = 0;
  for (let k = 0; k < n; k++) {
    if (k >= next) { tgt = r() < 0.3 ? 0 : (r() * 2 - 1) * 500; next = k + Math.round(fs * (0.15 + r() * 0.6)); }
    a1 += kSp * (tgt - a1); a2 += kSp * (a1 - a2); a3 += kSp * (a2 - a3);
    const sp = a3;
    const meas = w + (r() * 2 - 1) * 2; // шум гиро
    const e = sp - meas;
    I += T.ki * e * Ts;
    wd += kD * (meas - wd);
    const D = -T.kd * (wd - prevWd) / Ts;
    prevWd = wd;
    fsm += kF * ((sp - prevSp) / Ts - fsm);
    prevSp = sp;
    const P = T.kp * e, F = T.kf * fsm;
    const u = P + I + D + F;
    hist.push(u);
    const ud = hist.shift()!;
    // моторы (инерция) → угловое ускорение; ветер — случайная медленная помеха
    wind += (r() * 2 - 1) * 30 - wind * 0.002;
    acc = am * acc + (1 - am) * (T.K * ud + wind);
    w += acc * Ts;
    o.sp[k] = Math.round(sp); o.gy[k] = Math.round(meas); o.P[k] = P; o.I[k] = I; o.D[k] = D; o.F[k] = F;
  }
  return { ...o, fs };
}

/** истинный отклик системы на скачок setpoint (без шума и ветра) */
function trueStep(T: Truth, mult: { p: number; i: number; d: number; f: number }) {
  const fs = 2000, Ts = 1 / fs, R = Math.round(0.5 * fs);
  const kD = 1 - Math.exp(-2 * Math.PI * T.fD * Ts), kF = 1 - Math.exp(-2 * Math.PI * 30 * Ts);
  const dN = Math.round(T.delay * fs), am = Math.exp(-Ts / T.tau);
  const hist: number[] = new Array(dN + 1).fill(0);
  let w = 0, acc = 0, I = 0, wd = 0, prevWd = 0, fsm = 0, prevSp = 0;
  const t = new Float32Array(R), y = new Float32Array(R);
  for (let k = 0; k < R; k++) {
    const sp = 1;
    const e = sp - w;
    I += mult.i * T.ki * e * Ts;
    wd += kD * (w - wd);
    const D = -mult.d * T.kd * (wd - prevWd) / Ts;
    prevWd = wd;
    fsm += kF * ((sp - prevSp) / Ts - fsm);
    prevSp = sp;
    hist.push(mult.p * T.kp * e + I + D + mult.f * T.kf * fsm);
    const ud = hist.shift()!;
    acc = am * acc + (1 - am) * T.K * ud;
    w += acc * Ts;
    t[k] = k / fs; y[k] = w;
  }
  return stepMetrics({ t, mean: y });
}

// два борта: «звонкий» (перерегулирование ~36 %) и типичный (~10 %), разные моторы и задержки
for (const [name, T] of [
  ['звонкий борт', { tau: 0.012, delay: 0.004, K: 90, kp: 1.6, ki: 15, kd: 0.017, kf: 0.015, fD: 100 }],
  ['типичный борт', { tau: 0.02, delay: 0.006, K: 45, kp: 1.8, ki: 18, kd: 0.03, kf: 0.016, fD: 80 }],
] as [string, Truth][]) describe(`модель оси на синтетике: ${name}`, () => {
  const f = flight(T, 90);
  const use = new Uint8Array(f.sp.length).fill(1);
  const st = stepResponse(f.sp, f.gy, use, f.fs, cfg.pid)!;
  const x = decimate(f, use, f.fs, cfg.sysid.decimHz);
  const m = identifyAxis(0, x, { mean: st.mean, parts: st.parts, enough: true });

  it('регулятор восстановлен по записанным P/I/D/F', () => {
    expect(m.ctrl.pFit).toBeGreaterThan(0.97);
    expect(Math.abs(m.ctrl.kp / T.kp - 1)).toBeLessThan(0.05);
    expect(m.ctrl.dFit).toBeGreaterThan(0.8);
    expect(m.ok).toBe(true);
    expect(m.stepFit).toBeGreaterThan(80);
  });

  for (const g of [{ p: 1, i: 1, d: 1.3, f: 1 }, { p: 1.2, i: 1, d: 1, f: 1 }, { p: 1, i: 1, d: 1, f: 1.4 }, { p: 0.85, i: 1, d: 0.8, f: 1 }]) {
    it(`прогноз для ${JSON.stringify(g)} — у истинного отклика (±4 п.п., ±3 мс)`, () => {
      const fc = forecastAxis(m, g, Array.from(st.t));
      const truth = trueStep(T, g);
      expect(Math.abs(fc.overshoot.mid - truth.overshootPct)).toBeLessThan(4);
      expect(Math.abs(fc.delayMs.mid - truth.delayMs)).toBeLessThan(3);
      // направление изменения — как у истины
      const base = trueStep(T, SAME);
      expect(Math.sign(fc.overshoot.mid - fc.nowMetrics.overshoot)).toBe(Math.sign(truth.overshootPct - base.overshootPct) || Math.sign(fc.overshoot.mid - fc.nowMetrics.overshoot));
    });
  }
});

async function open(file: string, index: number) {
  const r = fileReader(file);
  const s = await scanFile(r);
  r.close();
  const L = s.logs.find((l) => l.index === index)!;
  const end = L.crossesWrap && L.wrapBoundary ? L.wrapBoundary : L.end;
  return analyzeLog(buildContext(decodeLog(readRange(file, L.start, end - L.start))));
}

describe.skipIf(!hasFixture(BIG_DUMP))('модель оси на логах 4.5.2', () => {
  it('№3: модель ролла и питча годна, регулятор объяснён', async () => {
    const a = await open(BIG_DUMP, 3);
    for (const ax of [0, 1]) {
      const m = a.sysid!.axes[ax];
      expect(m.ok).toBe(true);
      expect(m.stepFit).toBeGreaterThan(80);
      expect(m.ctrl.pFit).toBeGreaterThan(0.95);
    }
  });

  it('модель с №3 предсказывает №5 (те же настройки) в пределах полосы', async () => {
    const a3 = await open(BIG_DUMP, 3), a5 = await open(BIG_DUMP, 5);
    for (const ax of [0, 1]) {
      const fc = forecastAxis(a3.sysid!.axes[ax], SAME, a3.sysid!.t);
      const meas = a5.pid!.axes[ax].metrics!;
      expect(meas.overshootPct).toBeGreaterThanOrEqual(fc.overshoot.lo - 2);
      expect(meas.overshootPct).toBeLessThanOrEqual(fc.overshoot.hi + 2);
      expect(Math.abs(meas.delayMs - fc.delayMs.mid)).toBeLessThan(3);
    }
  });

  it('совет усилить фильтр D-term получает прогноз step response с полосой', async () => {
    const a = await open(BIG_DUMP, 3);
    const adv = adviseLog(a).advice.find((x) => x.id === 'R-FLT-DTERM-HOT-01')!;
    expect(adv.forecast?.length).toBe(2);
    for (const f of adv.forecast!) {
      expect(f.overshoot.lo).toBeLessThanOrEqual(f.overshoot.mid);
      expect(f.overshoot.hi).toBeGreaterThanOrEqual(f.overshoot.mid);
      // фильтр сильнее → задержка D больше → перерегулирование не меньше
      expect(f.overshoot.mid).toBeGreaterThanOrEqual(f.now.overshoot - 0.5);
    }
  });
});

describe.skipIf(!hasFixture(SMALL_DUMP))('модель оси на логе 2026.6.1 №4', () => {
  it('мало стиков → модели нет, прогноз не выдаётся', async () => {
    const a = await open(SMALL_DUMP, 4);
    for (const m of a.sysid!.axes) expect(m.ok).toBe(false);
  });
});
