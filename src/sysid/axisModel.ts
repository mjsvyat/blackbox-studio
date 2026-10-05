// Модель оси для прогноза PID (этап 7). Всё идентифицируется по логу:
//
//  регулятор — эффективные коэффициенты по записанным axisP/I/D/F (в них уже TPA,
//    anti-gravity, усреднённо — I-term relax и D max):
//      P = kp·(sp − ω),  ΔI = ki·(sp − ω)·Ts,  D = kd·(−Δω_D)/Ts (ω_D — ω через PT1 fD),
//      F = kf·PT1_fF(Δsp/Ts) со сдвигом lead (F считается из сырых стиков раньше сглаживания).
//    На логах 4.5.2 записанный P объясняется на 99 %, D — на 92–95 %.
//
//  объект — команда PID u → gyroADC (уже после фильтров гиро, их задержка входит в d):
//      Δ[k] = a·Δ[k−1] + b·u[k−1−d],  ω[k] = ω[k−1] + Δ[k]
//    (моторы — инерция a = exp(−Ts/τ), задержка d, корпус — интегратор).
//
//  Объект подбирается по ИЗМЕРЕННОМУ step response (pid/stepResponse.ts): замкнутая модель
//  с текущими коэффициентами должна дать ту же кривую. Почему не по сырым данным: ошибку
//  трекинга на логах в основном создают возмущения (пропвош, ветер), не связанные со
//  стиками, — разомкнутые и замкнутые подгонки «по времени» на логах дают fit ≈ 0. Step
//  response — детерминированная часть «стик → гиро», возмущения в нём усреднены.
//
//  Прогноз = та же модель с новыми коэффициентами (и новыми задержками фильтров). Полоса —
//  по объектам, подобранным на step response отдельных частей полёта, × калибровка по истории.

import cfg from '../config/analysis.json';

const C = cfg.sysid;

export interface PlantModel {
  /** exp(−Ts/τ) — инерция моторов */
  a: number;
  b: number;
  /** задержка, отсчётов модели (дробная — интерполяция) */
  d: number;
}

export interface CtrlModel {
  kp: number;
  ki: number;
  kd: number;
  /** PT1, эквивалентный фильтрам D-term, Гц */
  fD: number;
  kf: number;
  fF: number;
  /** F опережает записанный setpoint на lead отсчётов */
  lead: number;
  /** доля объяснённой дисперсии записанных P / D / F */
  pFit: number;
  dFit: number;
  fFit: number;
}

export interface AxisData {
  sp: Float64Array;
  gy: Float64Array;
  P: Float64Array;
  I: Float64Array;
  D: Float64Array;
  F: Float64Array;
  use: Uint8Array;
  fs: number;
}

export interface Gains {
  /** множители к текущим эффективным коэффициентам (новые / текущие P, I, D, F) */
  p: number;
  i: number;
  d: number;
  f: number;
  /** изменение задержки фильтров гиро и гиро+D-term (новые − текущие), мс */
  dGyroMs?: number;
  dDtermMs?: number;
}

export const SAME: Gains = { p: 1, i: 1, d: 1, f: 1 };

/** прореживание блоками (среднее), пригодность — весь блок пригоден */
export function decimate(src: { sp: ArrayLike<number>; gy: ArrayLike<number>; P: ArrayLike<number> | null; I: ArrayLike<number> | null; D: ArrayLike<number> | null; F: ArrayLike<number> | null }, use: Uint8Array, fs: number, targetHz: number): AxisData {
  const f = Math.max(1, Math.round(fs / targetHz));
  const n = Math.floor(src.sp.length / f);
  const mk = (): Float64Array => new Float64Array(n);
  const out: AxisData = { sp: mk(), gy: mk(), P: mk(), I: mk(), D: mk(), F: mk(), use: new Uint8Array(n), fs: fs / f };
  for (let j = 0; j < n; j++) {
    let ok = 1;
    for (let k = 0; k < f; k++) {
      const i = j * f + k;
      if (!use[i]) ok = 0;
      out.sp[j] += src.sp[i] / f;
      out.gy[j] += src.gy[i] / f;
      if (src.P) out.P[j] += src.P[i] / f;
      if (src.I) out.I[j] += src.I[i] / f;
      if (src.D) out.D[j] += src.D[i] / f;
      if (src.F) out.F[j] += src.F[i] / f;
    }
    out.use[j] = ok;
  }
  return out;
}

const pt1k = (fc: number, fs: number): number => {
  const rc = 1 / (2 * Math.PI * fc);
  return 1 / fs / (rc + 1 / fs);
};

/** y ≈ k·v по МНК: коэффициент и доля объяснённой дисперсии */
function ls1(pairs: (k: number) => [number, number] | null, n: number): { k: number; fit: number } {
  let vv = 0, yv = 0, yy = 0;
  for (let i = 0; i < n; i++) {
    const p = pairs(i);
    if (!p) continue;
    vv += p[1] * p[1]; yv += p[0] * p[1]; yy += p[0] * p[0];
  }
  if (!vv || !yy) return { k: 0, fit: 0 };
  const k = yv / vv;
  return { k, fit: 1 - (yy - 2 * k * yv + k * k * vv) / yy };
}

export function fitCtrl(x: AxisData): CtrlModel {
  const n = x.sp.length, Ts = 1 / x.fs;
  const ok = (k: number): boolean => k > 0 && x.use[k] === 1 && x.use[k - 1] === 1;
  const P = ls1((k) => (ok(k) ? [x.P[k], x.sp[k] - x.gy[k]] : null), n);
  const I = ls1((k) => (ok(k) ? [x.I[k] - x.I[k - 1], (x.sp[k - 1] - x.gy[k - 1]) * Ts] : null), n);
  // D: перебор fD
  let D = { k: 0, fit: -Infinity, f: C.dLpfHz[0] };
  for (const fD of C.dLpfHz) {
    const g = pt1k(fD, x.fs);
    const v = new Float64Array(n);
    let wd = x.gy[0], prev = wd;
    for (let k = 1; k < n; k++) { wd += g * (x.gy[k] - wd); v[k] = -(wd - prev) / Ts; prev = wd; }
    const r = ls1((k) => (ok(k) ? [x.D[k], v[k]] : null), n);
    if (r.fit > D.fit) D = { ...r, f: fD };
  }
  // F: перебор fF и сдвига lead
  let F = { k: 0, fit: -Infinity, f: C.fLpfHz[0], lead: 0 };
  for (const fF of C.fLpfHz) {
    const g = pt1k(fF, x.fs);
    const v = new Float64Array(n);
    let s = 0;
    for (let k = 1; k < n; k++) { s += g * ((x.sp[k] - x.sp[k - 1]) / Ts - s); v[k] = s; }
    for (let lead = 0; lead <= C.maxFfLead; lead++) {
      const r = ls1((k) => (k + lead < n && ok(k) ? [x.F[k], v[k + lead]] : null), n);
      if (r.fit > F.fit) F = { ...r, f: fF, lead };
    }
  }
  return {
    kp: P.k, ki: I.k, kd: D.fit > 0 ? D.k : 0, fD: D.f, kf: F.fit > 0 ? F.k : 0, fF: F.f, lead: F.lead,
    pFit: P.fit, dFit: Math.max(0, D.fit), fFit: Math.max(0, F.fit),
  };
}

/**
 * Переходная характеристика замкнутой модели на единичный скачок setpoint (как у
 * измеренной: отклик гироскопа на скачок записанного setpoint), R отсчётов.
 */
export function stepSim(plant: PlantModel, c: CtrlModel, g: Gains, R: number, fs: number): Float64Array {
  const Ts = 1 / fs;
  const pre = c.lead + 2; // F опережает — начинаем раньше скачка
  const dTot = Math.max(0, plant.d + ((g.dGyroMs ?? 0) / 1000) * fs);
  const d0 = Math.floor(dTot), fr = dTot - d0;
  const tauD = 1 / (2 * Math.PI * c.fD) + Math.max(-0.0005, ((g.dDtermMs ?? 0) - (g.dGyroMs ?? 0)) / 1000);
  const gD = Ts / (Math.max(1e-4, tauD) + Ts);
  const gF = pt1k(c.fF, fs);
  const N = R + pre;
  const u = new Float64Array(N);
  const out = new Float64Array(R);
  const spAt = (k: number): number => (k - pre >= 0 ? 1 : 0);
  // F: сглаженная производная setpoint (по всей длине + запас на опережение)
  const fAt = new Float64Array(N + c.lead + 1);
  let fs1 = 0, spPrev = 0;
  for (let k = 0; k < fAt.length; k++) {
    const s = spAt(k);
    fs1 += gF * ((s - spPrev) / Ts - fs1);
    spPrev = s;
    fAt[k] = fs1;
  }
  let w = 0, dl = 0, I = 0, wd = 0, prevD = 0;
  for (let k = 0; k < N; k++) {
    const ia = k - 1 - d0, ib = k - 2 - d0;
    const ua = ia >= 0 ? u[ia] : 0, ub = ib >= 0 ? u[ib] : 0;
    dl = plant.a * dl + plant.b * (ua * (1 - fr) + ub * fr);
    w += dl;
    const e = spAt(k) - w;
    I += g.i * c.ki * e * Ts;
    wd += gD * (w - wd);
    const D = g.d * c.kd * (-(wd - prevD) / Ts);
    prevD = wd;
    u[k] = g.p * c.kp * e + I + D + g.f * c.kf * fAt[k + c.lead];
    if (k >= pre) out[k - pre] = w;
  }
  return out;
}

const rmsDiff = (a: ArrayLike<number>, b: ArrayLike<number>, n: number): number => {
  let s = 0, c = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { s += (a[i] - b[i]) ** 2; c++; }
  return c ? Math.sqrt(s / c) : Infinity;
};

/** совпадение кривых, %: 100·(1 − rms(модель − измерено) / rms(измерено − 1)) на fitWindowS */
export function stepFitPercent(model: ArrayLike<number>, meas: ArrayLike<number>, fs: number): number {
  const n = Math.min(model.length, meas.length, Math.round(C.fitWindowS * fs));
  let s = 0, c = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(meas[i])) { s += (meas[i] - 1) ** 2; c++; }
  const ref = c ? Math.sqrt(s / c) : 1;
  return 100 * (1 - rmsDiff(model, meas, n) / ref);
}

/** подбор объекта под измеренную кривую: перебор τ, d; b — золотое сечение по log(b) */
export function fitPlantToStep(meas: ArrayLike<number>, c: CtrlModel, fs: number, fixed?: { a: number; d: number }): { plant: PlantModel; fit: number } | null {
  const R = Math.min(meas.length, Math.round(C.fitWindowS * fs));
  const Ts = 1 / fs;
  const as = fixed ? [fixed.a] : C.motorTauMs.map((t) => Math.exp(-Ts / (t / 1000)));
  const steps = Math.round(((C.maxDelayMs / 1000) * fs) / C.delayStep);
  const ds = fixed ? [fixed.d] : Array.from({ length: steps + 1 }, (_, i) => i * C.delayStep);
  let best: { plant: PlantModel; fit: number } | null = null;
  for (const a of as) {
    for (const d of ds) {
      const err = (lb: number): number => rmsDiff(stepSim({ a, b: Math.exp(lb), d }, c, SAME, R, fs), meas, R);
      let lo = Math.log(1e-5), hi = Math.log(1);
      const gr = (Math.sqrt(5) - 1) / 2;
      let c1 = hi - gr * (hi - lo), c2 = lo + gr * (hi - lo);
      let f1 = err(c1), f2 = err(c2);
      for (let it = 0; it < C.gainIters; it++) {
        if (f1 < f2) { hi = c2; c2 = c1; f2 = f1; c1 = hi - gr * (hi - lo); f1 = err(c1); }
        else { lo = c1; c1 = c2; f1 = f2; c2 = lo + gr * (hi - lo); f2 = err(c2); }
      }
      const plant = { a, b: Math.exp(f1 < f2 ? c1 : c2), d };
      const fit = stepFitPercent(stepSim(plant, c, SAME, R, fs), meas, fs);
      if (!best || fit > best.fit) best = { plant, fit };
    }
  }
  return best;
}

export interface AxisModel {
  axis: number;
  fs: number;
  plant: PlantModel;
  ctrl: CtrlModel;
  /** совпадение модельной кривой с измеренной, % */
  stepFit: number;
  /** объекты, подобранные по кривым отдельных частей полёта (для полосы) */
  parts: PlantModel[];
  ok: boolean;
  why: 'ok' | 'no-step' | 'no-ctrl' | 'bad-fit';
  /** по чему подобран объект: step response обычного полёта или АЧХ/ФЧХ chirp (C) */
  source?: 'step' | 'chirp';
}

export function identifyAxis(axis: number, x: AxisData, step: { mean: ArrayLike<number>; parts: ArrayLike<number>[]; enough: boolean }): AxisModel {
  const ctrl = fitCtrl(x);
  const empty: PlantModel = { a: 0, b: 0, d: 0 };
  if (!step.enough) return { axis, fs: x.fs, plant: empty, ctrl, stepFit: NaN, parts: [], ok: false, why: 'no-step' };
  if (ctrl.kp <= 0 || ctrl.pFit < C.minCtrlFit) return { axis, fs: x.fs, plant: empty, ctrl, stepFit: NaN, parts: [], ok: false, why: 'no-ctrl' };
  const r = fitPlantToStep(step.mean, ctrl, x.fs);
  if (!r) return { axis, fs: x.fs, plant: empty, ctrl, stepFit: NaN, parts: [], ok: false, why: 'bad-fit' };
  // по частям — те же τ и d (свойства моторов), усиление — по части
  const parts = step.parts.map((p) => fitPlantToStep(p, ctrl, x.fs, { a: r.plant.a, d: r.plant.d })?.plant).filter((p): p is PlantModel => !!p);
  const ok = r.fit >= C.minStepFit;
  return { axis, fs: x.fs, plant: r.plant, ctrl, stepFit: r.fit, parts, ok, why: ok ? 'ok' : 'bad-fit' };
}
