// Идентификация по chirp (C) на синтетике: объект с известной частотной характеристикой и
// задержкой, BF-подобный регулятор, chirp-возбуждение по формуле common/chirp.c BF 2026.6.1,
// ветер и шум гиро. Проверки: АЧХ ±1 дБ в полосе когерентности, запасы устойчивости,
// модель по chirp предсказывает истинный step response.
import { describe, expect, it } from 'vitest';
import cfg from '../src/config/analysis.json';
import { stepMetrics } from '../src/pid/stepResponse';
import { CtrlModel, PlantModel, SAME, decimate, fitCtrl, stepSim } from '../src/sysid/axisModel';
import { abs, bandwidthHz, fitPlantToFrf, margins, modelFrf, trusted, welchFrf } from '../src/sysid/frf';
import { analyzeChirp, compareModels } from '../src/sysid/chirp';
import { identifyAxis } from '../src/sysid/axisModel';
import { stepResponse } from '../src/pid/stepResponse';
import type { LogContext } from '../src/analysis/context';

function rng(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

interface Truth { tau: number; delay: number; K: number; kp: number; ki: number; kd: number; kf: number; fD: number }
const FS = 2000;

/** BF common/chirp.c: экспоненциальный chirp, cos, ниже 1 Гц амплитуда × f */
function chirpSignal(f0: number, f1: number, t1: number, fs: number): Float64Array {
  const Ts = 1 / fs, N = Math.floor(t1 / Ts);
  const beta = (f1 / f0) ** (1 / t1), k0 = (2 * Math.PI) / Math.log(beta), k1 = k0 * f0;
  const out = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const fc = f0 * beta ** (n * Ts);
    let exc = Math.cos((k0 * fc - k1) % (2 * Math.PI));
    if (fc < 1) exc *= fc;
    out[n] = exc;
  }
  return out;
}

/** «chirp-полёт»: висение, возбуждение по оси, ветер, шум гиро; регулятор как в sysid.test */
function chirpFlight(T: Truth, amp: number, seed = 5) {
  const ex = chirpSignal(0.2, 200, 20, FS);
  const n = ex.length + FS * 2, Ts = 1 / FS, r = rng(seed);
  const o = { sp: new Float32Array(n), gy: new Float32Array(n), P: new Float32Array(n), I: new Float32Array(n), D: new Float32Array(n), F: new Float32Array(n), u: new Float32Array(n) };
  const kD = 1 - Math.exp(-2 * Math.PI * T.fD * Ts), kF = 1 - Math.exp(-2 * Math.PI * 30 * Ts);
  const dN = Math.round(T.delay * FS), am = Math.exp(-Ts / T.tau);
  const hist: number[] = new Array(dN + 1).fill(0);
  let w = 0, acc = 0, I = 0, wd = 0, prevWd = 0, fsm = 0, prevSp = 0, wind = 0;
  for (let k = 0; k < n; k++) {
    const sp = k >= FS && k - FS < ex.length ? amp * ex[k - FS] : 0;
    const meas = w + (r() * 2 - 1) * 2;
    const e = sp - meas;
    I += T.ki * e * Ts;
    wd += kD * (meas - wd);
    const D = -T.kd * (wd - prevWd) / Ts;
    prevWd = wd;
    fsm += kF * ((sp - prevSp) / Ts - fsm);
    prevSp = sp;
    const P = T.kp * e, F = T.kf * fsm, u = P + I + D + F;
    hist.push(u);
    const ud = hist.shift()!;
    wind += (r() * 2 - 1) * 30 - wind * 0.002;
    acc = am * acc + (1 - am) * (T.K * ud + wind);
    w += acc * Ts;
    o.sp[k] = Math.round(sp); o.gy[k] = Math.round(meas); o.P[k] = P; o.I[k] = I; o.D[k] = D; o.F[k] = F; o.u[k] = u;
  }
  return o;
}

/** истинная модель в терминах modelFrf (дискретная система симуляции, 2 кГц) */
function truthModel(T: Truth): { plant: PlantModel; ctrl: CtrlModel } {
  const Ts = 1 / FS, am = Math.exp(-Ts / T.tau), dN = Math.round(T.delay * FS);
  const kD = 1 - Math.exp(-2 * Math.PI * T.fD * Ts), kF = 1 - Math.exp(-2 * Math.PI * 30 * Ts);
  // PT1 modelFrf: g = Ts/(τ+Ts) → τ = Ts/g − Ts
  const fEq = (g: number): number => 1 / (2 * Math.PI * (Ts / g - Ts));
  return {
    plant: { a: am, b: (1 - am) * T.K * Ts, d: dN + 1 },
    ctrl: { kp: T.kp, ki: T.ki, kd: T.kd, fD: fEq(kD), kf: T.kf, fF: fEq(kF), lead: 0, pFit: 1, dFit: 1, fFit: 1 },
  };
}

function trueStep(T: Truth, g = SAME) {
  const tm = truthModel(T);
  const y = stepSim(tm.plant, tm.ctrl, g, Math.round(0.5 * FS), FS);
  const t = Float32Array.from({ length: y.length }, (_, i) => i / FS);
  return stepMetrics({ t, mean: Float32Array.from(y) });
}

const db = (v: number): number => 20 * Math.log10(v);

for (const [name, T] of [
  ['звонкий борт', { tau: 0.012, delay: 0.004, K: 90, kp: 1.6, ki: 15, kd: 0.017, kf: 0.015, fD: 100 }],
  ['типичный борт', { tau: 0.02, delay: 0.006, K: 45, kp: 1.8, ki: 18, kd: 0.03, kf: 0.016, fD: 80 }],
] as [string, Truth][]) describe(`chirp на синтетике: ${name}`, () => {
  const fl = chirpFlight(T, 230);
  const use = new Uint8Array(fl.sp.length).fill(1);
  const truth = truthModel(T);

  it('АЧХ замкнутого контура ±1 дБ и фаза ±10° в полосе когерентности (≥ 0.9), 1…150 Гц', () => {
    const m = welchFrf(fl.sp, fl.gy, use, FS, 2048, 250);
    const idx = trusted(m, { minCoh: 0.9, fMin: 1, fMax: 150 });
    expect(idx.length).toBeGreaterThan(100);
    const tf = modelFrf(truth.plant, truth.ctrl, idx.map((i) => m.f[i]), FS).T;
    let worstDb = 0, worstPh = 0;
    idx.forEach((i, j) => {
      worstDb = Math.max(worstDb, Math.abs(db(Math.hypot(m.re[i], m.im[i])) - db(abs(tf[j]))));
      let dp = Math.atan2(m.im[i], m.re[i]) - Math.atan2(tf[j][1], tf[j][0]);
      dp = Math.atan2(Math.sin(dp), Math.cos(dp));
      worstPh = Math.max(worstPh, Math.abs((dp * 180) / Math.PI));
    });
    expect(worstDb).toBeLessThan(1);
    expect(worstPh).toBeLessThan(10);
  });

  it('запасы устойчивости по измеренному объекту ≈ истинным (±3°, ±1 дБ)', () => {
    // объект косвенно: (gyro/setpoint) / (команда/setpoint) — как в sysid/chirp.ts
    const ty = welchFrf(fl.sp, fl.gy, use, FS, 2048, 250), tu = welchFrf(fl.sp, fl.u, use, FS, 2048, 250);
    const p = { ...ty, re: [] as number[], im: [] as number[], coh: ty.coh.map((c, i) => Math.min(c, tu.coh[i])) };
    ty.f.forEach((_, i) => {
      const d = tu.re[i] ** 2 + tu.im[i] ** 2;
      p.re.push((ty.re[i] * tu.re[i] + ty.im[i] * tu.im[i]) / d);
      p.im.push((ty.im[i] * tu.re[i] - ty.re[i] * tu.im[i]) / d);
    });
    const idx = trusted(p, { minCoh: 0.8, fMin: 1, fMax: 250 });
    const f = idx.map((i) => p.f[i]);
    // L = P_изм · C (регулятор известен): C = L_ист / P_ист
    const tl = modelFrf(truth.plant, truth.ctrl, f, FS);
    const Lm = idx.map((i, j): [number, number] => {
      const C = [tl.L[j][0], tl.L[j][1]], Pt = tl.P[j];
      const d = Pt[0] ** 2 + Pt[1] ** 2;
      const c: [number, number] = [(C[0] * Pt[0] + C[1] * Pt[1]) / d, (C[1] * Pt[0] - C[0] * Pt[1]) / d];
      return [p.re[i] * c[0] - p.im[i] * c[1], p.re[i] * c[1] + p.im[i] * c[0]];
    });
    const mm = margins(f, Lm);
    const mt = margins(f, tl.L);
    expect(mt.pmDeg).not.toBeNull();
    expect(Math.abs(mm.pmDeg! - mt.pmDeg!)).toBeLessThan(3);
    expect(Math.abs(mm.crossHz! - mt.crossHz!) / mt.crossHz!).toBeLessThan(0.05);
    if (mt.gmDb !== null) expect(Math.abs(mm.gmDb! - mt.gmDb)).toBeLessThan(1);
    const bw = bandwidthHz(f, tl.T);
    expect(bw).not.toBeNull();
  });

  it('модель по chirp: объект по АЧХ/ФЧХ, прогноз step response ±4 п.п. / ±3 мс от истинного', () => {
    const x = decimate(fl, use, FS, cfg.sysid.decimHz);
    // регулятор — на частоте лога: chirp возбуждает высокие частоты, и после прореживания
    // усреднением D-фильтр и F подбираются со смещением (проверено: срез D 220 Гц вместо 100)
    const cf = fitCtrl(decimate(fl, use, FS, FS));
    const ctrl = { ...cf, lead: Math.round((cf.lead * x.fs) / FS) };
    expect(ctrl.pFit).toBeGreaterThan(0.9);
    const meas = welchFrf(x.sp, x.gy, x.use, x.fs, 1024, x.fs / 2);
    const C = cfg.chirp;
    const r = fitPlantToFrf(meas, ctrl, x.fs, { minCoh: C.minCoh, fMin: C.fitFMin, fMax: C.fitFMax }, { tauMs: cfg.sysid.motorTauMs, maxDelayMs: cfg.sysid.maxDelayMs, delayStep: cfg.sysid.delayStep, iters: cfg.sysid.gainIters })!;
    expect(r.fit).toBeGreaterThan(90);
    for (const g of [SAME, { p: 1.2, i: 1, d: 1, f: 1 }, { p: 1, i: 1, d: 1.3, f: 1 }, { p: 0.85, i: 1, d: 0.8, f: 1 }]) {
      const y = stepSim(r.plant, ctrl, g, Math.round(0.5 * x.fs), x.fs);
      const t = Float32Array.from({ length: y.length }, (_, i) => i / x.fs);
      const pm = stepMetrics({ t, mean: Float32Array.from(y) });
      const tm = trueStep(T, g);
      expect(Math.abs(pm.overshootPct - tm.overshootPct), JSON.stringify(g)).toBeLessThan(4);
      expect(Math.abs(pm.delayMs - tm.delayMs), JSON.stringify(g)).toBeLessThan(3);
    }
  });
});

/** обычный «полёт» (стики) — как в sysid.test, для модели по step response */
function freestyle(T: Truth, secs: number, seed = 3) {
  const Ts = 1 / FS, n = secs * FS, r = rng(seed);
  const o = { sp: new Float32Array(n), gy: new Float32Array(n), P: new Float32Array(n), I: new Float32Array(n), D: new Float32Array(n), F: new Float32Array(n) };
  const kSp = 1 - Math.exp(-2 * Math.PI * 40 * 1.96 * Ts), kD = 1 - Math.exp(-2 * Math.PI * T.fD * Ts), kF = 1 - Math.exp(-2 * Math.PI * 30 * Ts);
  const dN = Math.round(T.delay * FS), am = Math.exp(-Ts / T.tau);
  const hist: number[] = new Array(dN + 1).fill(0);
  let tgt = 0, next = 0, a1 = 0, a2 = 0, a3 = 0, w = 0, acc = 0, I = 0, wd = 0, prevWd = 0, fsm = 0, prevSp = 0, wind = 0;
  for (let k = 0; k < n; k++) {
    if (k >= next) { tgt = r() < 0.3 ? 0 : (r() * 2 - 1) * 500; next = k + Math.round(FS * (0.15 + r() * 0.6)); }
    a1 += kSp * (tgt - a1); a2 += kSp * (a1 - a2); a3 += kSp * (a2 - a3);
    const sp = a3, meas = w + (r() * 2 - 1) * 2, e = sp - meas;
    I += T.ki * e * Ts; wd += kD * (meas - wd);
    const D = -T.kd * (wd - prevWd) / Ts; prevWd = wd;
    fsm += kF * ((sp - prevSp) / Ts - fsm); prevSp = sp;
    const P = T.kp * e, F = T.kf * fsm;
    hist.push(P + I + D + F);
    const ud = hist.shift()!;
    wind += (r() * 2 - 1) * 30 - wind * 0.002;
    acc = am * acc + (1 - am) * (T.K * ud + wind); w += acc * Ts;
    o.sp[k] = Math.round(sp); o.gy[k] = Math.round(meas); o.P[k] = P; o.I[k] = I; o.D[k] = D; o.F[k] = F;
  }
  return o;
}

describe('chirp в логе: поиск участка, запасы, модель по chirp и сравнение с моделью по фристайлу', () => {
  const T: Truth = { tau: 0.02, delay: 0.006, K: 45, kp: 1.8, ki: 18, kd: 0.03, kf: 0.016, fD: 80 };
  const fl = chirpFlight(T, 230);
  // «лог» 2026.6.1: S-кадры с флагом CHIRP (бит 6 в boxId_e 2026.6) на время возбуждения
  const n = fl.sp.length;
  const cols = [fl.sp, fl.gy, fl.P, fl.I, fl.D, fl.F];
  const names = ['setpoint[0]', 'gyroADC[0]', 'axisP[0]', 'axisI[0]', 'axisD[0]', 'axisF[0]'];
  const H: Record<string, string> = { chirp_lag_freq_hz: '3', chirp_lead_freq_hz: '30', chirp_amplitude_roll: '230', chirp_amplitude_pitch: '230', chirp_amplitude_yaw: '180', chirp_frequency_start_deci_hz: '2', chirp_frequency_end_deci_hz: '2000', chirp_time_seconds: '20', debug_mode: '0' };
  const ctx = {
    log: { header: H, index: Object.fromEntries(names.map((k, i) => [k, i])), cols, slowFieldNames: ['flightModeFlags'], time: Float64Array.from({ length: n }, (_, i) => (i * 1e6) / FS),
      slow: [{ t: 0, v: [1] }, { t: 1e6, v: [1 | (1 << 6)] }, { t: 21e6, v: [1] }] },
    n, fs: FS, tSec: Float64Array.from({ length: n }, (_, i) => i / FS), fw: { code: 2_026_006_001 }, motorNorm: [],
  } as unknown as LogContext;

  it('участок найден, ось — по setpoint, запасы ≈ истинным, модель по chirp годна, полосы сравниваются', () => {
    const r = analyzeChirp(ctx, new Uint8Array(n).fill(1));
    expect(r.fw.inFirmware).toBe(true);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ axis: 0, axisFrom: 'setpoint' });
    expect(r.segments[0].seconds).toBeCloseTo(20, 0);
    const ax = r.axes.find((a) => a.axis === 0)!;
    expect(ax.source).toBe('chirp');
    expect(ax.marginsOk).toBe(true);
    const truth = truthModel(T);
    const f = Array.from({ length: 2000 }, (_, i) => 0.5 + i * 0.125);
    const mt = margins(f, modelFrf(truth.plant, truth.ctrl, f, FS).L);
    expect(Math.abs(ax.margins!.pmDeg! - mt.pmDeg!)).toBeLessThan(5);
    const cm = r.models.find((m) => m.axis === 0)!;
    expect(cm.ok).toBe(true);
    // модель по обычному полёту того же борта (90 с стиков) — как в этапе 7
    const ff = freestyle(T, 90);
    const use = new Uint8Array(ff.sp.length).fill(1);
    const st = stepResponse(ff.sp, ff.gy, use, FS, cfg.pid)!;
    const fm = identifyAxis(0, decimate(ff, use, FS, cfg.sysid.decimHz), { mean: st.mean, parts: st.parts, enough: true });
    const cmp = compareModels(fm, cm);
    // на синтетике «фристайл» стационарен — обе полосы ниже минимальной полуширины прогноза
    // (sysid.bandMinPp); «по chirp уже» проверяется только на настоящем chirp-логе (PLAN.md, C)
    expect(cmp.chirpBandPp).toBeLessThan(cfg.sysid.bandMinPp);
    expect(cmp.flightBandPp!).toBeLessThan(cfg.sysid.bandMinPp);
    expect(cmp.chirpFit).toBeGreaterThan(90);
    // прогноз по chirp-модели — в пределах ±4 п.п. от истинного для D ×1.2
    const g = { p: 1, i: 1, d: 1.2, f: 1 };
    const y = stepSim(cm.plant, cm.ctrl, g, Math.round(0.5 * cm.fs), cm.fs);
    const pm = stepMetrics({ t: Float32Array.from({ length: y.length }, (_, i) => i / cm.fs), mean: Float32Array.from(y) });
    expect(Math.abs(pm.overshootPct - trueStep(T, g).overshootPct)).toBeLessThan(4);
    // печать для PLAN.md
    console.log(`полоса прогноза (D ×1.2): фристайл ${cmp.flightBandPp!.toFixed(1)} п.п., chirp ${cmp.chirpBandPp.toFixed(1)} п.п.; совпадение ${cmp.flightFit?.toFixed(0)} % / ${cmp.chirpFit.toFixed(0)} %`);
  });
});
