// Частотная характеристика (C): оценка по логу и по модели оси, запасы устойчивости, подбор объекта.
//
// По логу (Уэлч, окно Ханна, 50 % перекрытие, только куски, где все отсчёты пригодны):
//   H = Pyu / Puu (оценка H1), когерентность γ² = |Pyu|² / (Puu·Pyy) — где γ² мала, вход почти
//   не возбуждал систему или мешают возмущения; там данным не верим.
//   - замкнутый контур T: setpoint → gyroADC (chirp прибавляется к setpoint до записи в лог,
//     pid.c 2026.6.1 — так что setpoint уже содержит возбуждение);
//   - объект P: команда PID (axisP + I + D + F) → gyroADC.
// По модели (axisModel.ts, та же дискретная модель, что stepSim, z = e^{jωTs}):
//   P(z) = b·z^{−1−d} / ((1 − a·z^{−1})(1 − z^{−1})),  K = kp + ki·Ts/(1 − z^{−1}),
//   Dz = kd·PT1(fD)·(1 − z^{−1})/Ts (по измерению),  Ff = kf·PT1(fF)·(1 − z^{−1})/Ts·z^{lead},
//   L = P·(K + Dz) (разомкнутый контур на входе объекта), T = P·(K + Ff) / (1 + L).
// Запасы — по L: на частоте среза |L| = 1 запас по фазе 180° + ∠L; где ∠L = −180° — запас по
// амплитуде −20·lg|L|. Полоса — где |T| падает до −3 дБ от низкочастотного уровня.

import { fft, hann } from '../dsp/fft';
import { segmentStarts } from '../dsp/spectrum';
import { CtrlModel, Gains, PlantModel, SAME } from './axisModel';

export interface Frf {
  f: number[];
  re: number[];
  im: number[];
  coh: number[];
  /** сколько окон усреднено */
  segments: number;
}

/** оценка H1 и когерентность по пригодным кускам (use), окно nfft отсчётов; pick — какие окна брать */
export function welchFrf(u: ArrayLike<number>, y: ArrayLike<number>, use: Uint8Array, fs: number, nfft: number, fMax = fs / 2, pick?: (k: number) => boolean): Frf {
  const starts = segmentStarts(use, u.length, nfft, nfft >> 1).filter((_, k) => !pick || pick(k));
  const { w } = hann(nfft);
  const nb = Math.min(nfft >> 1, Math.floor((fMax * nfft) / fs));
  const puu = new Float64Array(nb + 1), pyy = new Float64Array(nb + 1), pr = new Float64Array(nb + 1), pi = new Float64Array(nb + 1);
  const ur = new Float64Array(nfft), ui = new Float64Array(nfft), yr = new Float64Array(nfft), yi = new Float64Array(nfft);
  for (const s of starts) {
    let mu = 0, my = 0;
    for (let i = 0; i < nfft; i++) { mu += u[s + i]; my += y[s + i]; }
    mu /= nfft; my /= nfft;
    for (let i = 0; i < nfft; i++) {
      ur[i] = (u[s + i] - mu) * w[i]; ui[i] = 0;
      yr[i] = (y[s + i] - my) * w[i]; yi[i] = 0;
    }
    fft(ur, ui);
    fft(yr, yi);
    for (let k = 1; k <= nb; k++) {
      puu[k] += ur[k] * ur[k] + ui[k] * ui[k];
      pyy[k] += yr[k] * yr[k] + yi[k] * yi[k];
      // Y·conj(U)
      pr[k] += yr[k] * ur[k] + yi[k] * ui[k];
      pi[k] += yi[k] * ur[k] - yr[k] * ui[k];
    }
  }
  const out: Frf = { f: [], re: [], im: [], coh: [], segments: starts.length };
  for (let k = 1; k <= nb; k++) {
    if (!puu[k]) continue;
    out.f.push((k * fs) / nfft);
    out.re.push(pr[k] / puu[k]);
    out.im.push(pi[k] / puu[k]);
    out.coh.push(pyy[k] ? (pr[k] ** 2 + pi[k] ** 2) / (puu[k] * pyy[k]) : 0);
  }
  return out;
}

// --- комплексная арифметика на парах [re, im] ---
type Cx = [number, number];
const mul = (a: Cx, b: Cx): Cx => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const div = (a: Cx, b: Cx): Cx => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const add = (a: Cx, b: Cx): Cx => [a[0] + b[0], a[1] + b[1]];
const sc = (a: Cx, k: number): Cx => [a[0] * k, a[1] * k];
/** z^{−n} при z = e^{jθ}: e^{−jnθ} */
const zp = (th: number, n: number): Cx => [Math.cos(-n * th), Math.sin(-n * th)];
export const abs = (a: Cx): number => Math.hypot(a[0], a[1]);

export interface ModelFrf {
  f: number[];
  T: Cx[];
  L: Cx[];
  P: Cx[];
}

/** частотная характеристика модели оси на частотах f (Гц) */
export function modelFrf(plant: PlantModel, c: CtrlModel, f: number[], fs: number, g: Gains = SAME): ModelFrf {
  const Ts = 1 / fs;
  const dTot = Math.max(0, plant.d + ((g.dGyroMs ?? 0) / 1000) * fs);
  const tauD = 1 / (2 * Math.PI * c.fD) + Math.max(-0.0005, ((g.dDtermMs ?? 0) - (g.dGyroMs ?? 0)) / 1000);
  const gD = Ts / (Math.max(1e-4, tauD) + Ts);
  const tauF = 1 / (2 * Math.PI * c.fF);
  const gF = Ts / (tauF + Ts);
  const out: ModelFrf = { f, T: [], L: [], P: [] };
  for (const hz of f) {
    const th = 2 * Math.PI * hz * Ts;
    const z1 = zp(th, 1);
    const one: Cx = [1, 0];
    const dif: Cx = [1 - z1[0], -z1[1]]; // 1 − z^{−1}
    const P = div(sc(zp(th, 1 + dTot), plant.b), mul([1 - plant.a * z1[0], -plant.a * z1[1]], dif));
    const K = add([g.p * c.kp, 0], div(sc(one, g.i * c.ki * Ts), dif));
    const pt1 = (k: number): Cx => div([k, 0], [1 - (1 - k) * z1[0], -(1 - k) * z1[1]]);
    const Dz = sc(mul(pt1(gD), dif), (g.d * c.kd) / Ts);
    const Ff = sc(mul(mul(pt1(gF), dif), zp(th, -c.lead)), (g.f * c.kf) / Ts);
    const L = mul(P, add(K, Dz));
    const T = div(mul(P, add(K, Ff)), add(one, L));
    out.P.push(P);
    out.L.push(L);
    out.T.push(T);
  }
  return out;
}

/** регулятор по ошибке и измерению: K + Dz (вход объекта = −(K + Dz)·ω + …), для L = P_изм · это */
export function ctrlLoopFrf(c: CtrlModel, f: number[], fs: number): Cx[] {
  // L = P·(K + Dz) при P = 1 — та же формула, что в modelFrf
  return f.map((hz) => {
    const Ts = 1 / fs, th = 2 * Math.PI * hz * Ts;
    const z1 = zp(th, 1);
    const dif: Cx = [1 - z1[0], -z1[1]];
    const K = add([c.kp, 0], div([c.ki * Ts, 0], dif));
    const gD = Ts / (1 / (2 * Math.PI * c.fD) + Ts);
    const pt1: Cx = div([gD, 0], [1 - (1 - gD) * z1[0], -(1 - gD) * z1[1]]);
    return add(K, sc(mul(pt1, dif), c.kd / Ts));
  });
}

export const cmul = mul;

/** фаза, градусы, без скачков на ±180 */
export function unwrapDeg(z: Cx[]): number[] {
  const out: number[] = [];
  let prev = 0, off = 0;
  z.forEach((v, i) => {
    let p = (Math.atan2(v[1], v[0]) * 180) / Math.PI;
    if (i) {
      while (p + off - prev > 180) off -= 360;
      while (p + off - prev < -180) off += 360;
    }
    prev = p + off;
    out.push(prev);
  });
  return out;
}

export interface Margins {
  /** частота среза |L| = 1, Гц */
  crossHz: number | null;
  /** запас по фазе, градусы */
  pmDeg: number | null;
  /** частота, где ∠L = −180°, Гц */
  phase180Hz: number | null;
  /** запас по амплитуде, дБ */
  gmDb: number | null;
}

/**
 * Запасы по разомкнутому контуру L (первые пересечения, линейная интерполяция). ok — каким точкам
 * верим: пересечение засчитывается только между двумя соседними доверенными точками (иначе
 * интерполяция через провал когерентности даёт мусор — проверено на обычных полётах).
 */
export function margins(f: number[], L: Cx[], ok: (i: number) => boolean = () => true): Margins {
  const mag = L.map(abs);
  const ph = unwrapDeg(L);
  // привести фазу к диапазону, где на низких частотах она около −90…−180 (интегратор объекта)
  const shift = Math.round((ph[0] + 90) / 360) * 360;
  for (let i = 0; i < ph.length; i++) ph[i] -= shift;
  const m: Margins = { crossHz: null, pmDeg: null, phase180Hz: null, gmDb: null };
  let ic = -1;
  for (let i = 1; i < f.length && ic < 0; i++) {
    if (ok(i - 1) && ok(i) && mag[i - 1] >= 1 && mag[i] < 1) {
      const a = Math.log(mag[i - 1]) / (Math.log(mag[i - 1]) - Math.log(mag[i]));
      m.crossHz = f[i - 1] + a * (f[i] - f[i - 1]);
      m.pmDeg = 180 + ph[i - 1] + a * (ph[i] - ph[i - 1]);
      ic = i;
    }
  }
  // запас по амплитуде — только выше среза: на низких частотах фаза около −180° из-за I-члена,
  // там пересечения не про устойчивость
  for (let i = Math.max(1, ic); i < f.length; i++) {
    if (ok(i - 1) && ok(i) && ph[i - 1] > -180 && ph[i] <= -180) {
      const a = (ph[i - 1] + 180) / (ph[i - 1] - ph[i]);
      m.phase180Hz = f[i - 1] + a * (f[i] - f[i - 1]);
      const lm = Math.log(mag[i - 1]) + a * (Math.log(mag[i]) - Math.log(mag[i - 1]));
      m.gmDb = (-20 * lm) / Math.LN10;
      break;
    }
  }
  return m;
}

/** полоса замкнутого контура: где |T| впервые падает ниже −3 дБ от уровня на fRefHz */
export function bandwidthHz(f: number[], T: Cx[], ok: (i: number) => boolean = () => true, fRefHz = 2): number | null {
  let ref = NaN;
  for (let i = 0; i < f.length; i++) if (ok(i) && f[i] >= fRefHz) { ref = abs(T[i]); break; }
  if (!Number.isFinite(ref)) return null;
  for (let i = 1; i < f.length; i++) {
    if (!ok(i) || f[i] < fRefHz) continue;
    if (abs(T[i]) < ref / Math.SQRT2) return f[i];
  }
  return null;
}

export interface FrfFitOpts {
  minCoh: number;
  fMin: number;
  fMax: number;
}

/** индексы «доверенных» частот: когерентность и диапазон */
export function trusted(m: Frf, o: FrfFitOpts): number[] {
  const idx: number[] = [];
  for (let i = 0; i < m.f.length; i++) if (m.coh[i] >= o.minCoh && m.f[i] >= o.fMin && m.f[i] <= o.fMax) idx.push(i);
  return idx;
}

/** ошибка модели против измерения: логарифм модуля и фаза, вес — когерентность */
function frfErr(meas: Frf, idx: number[], model: Cx[]): number {
  let s = 0, w = 0;
  idx.forEach((i, j) => {
    const mm = Math.hypot(meas.re[i], meas.im[i]);
    const md = abs(model[j]);
    if (!mm || !md) return;
    let dp = Math.atan2(model[j][1], model[j][0]) - Math.atan2(meas.im[i], meas.re[i]);
    dp = Math.atan2(Math.sin(dp), Math.cos(dp));
    const c = meas.coh[i];
    s += c * ((Math.log(md / mm)) ** 2 + dp * dp);
    w += c;
  });
  return w ? s / w : Infinity;
}

/** совпадение, %: 100·(1 − ‖T_модель − T_изм‖ / ‖T_изм‖) по доверенным частотам */
export function frfFitPercent(meas: Frf, idx: number[], model: Cx[]): number {
  let e = 0, r = 0;
  idx.forEach((i, j) => {
    e += (model[j][0] - meas.re[i]) ** 2 + (model[j][1] - meas.im[i]) ** 2;
    r += meas.re[i] ** 2 + meas.im[i] ** 2;
  });
  return r ? 100 * (1 - Math.sqrt(e / r)) : NaN;
}

/**
 * Подбор объекта (a, d, b) так, чтобы замкнутая модель с идентифицированным регулятором дала
 * измеренную T (setpoint → gyro): перебор τ и дробной задержки, b — золотое сечение по log b.
 */
export function fitPlantToFrf(meas: Frf, c: CtrlModel, fs: number, o: FrfFitOpts, cand: { tauMs: number[]; maxDelayMs: number; delayStep: number; iters: number }, fixed?: { a: number; d: number }): { plant: PlantModel; fit: number; err: number } | null {
  const idx = trusted(meas, o);
  if (idx.length < 8) return null;
  const f = idx.map((i) => meas.f[i]);
  const Ts = 1 / fs;
  const as = fixed ? [fixed.a] : cand.tauMs.map((t) => Math.exp(-Ts / (t / 1000)));
  const steps = Math.round(((cand.maxDelayMs / 1000) * fs) / cand.delayStep);
  const ds = fixed ? [fixed.d] : Array.from({ length: steps + 1 }, (_, i) => i * cand.delayStep);
  let best: { plant: PlantModel; fit: number; err: number } | null = null;
  for (const a of as) {
    for (const d of ds) {
      const err = (lb: number): number => frfErr(meas, idx, modelFrf({ a, b: Math.exp(lb), d }, c, f, fs).T);
      let lo = Math.log(1e-5), hi = Math.log(1);
      const gr = (Math.sqrt(5) - 1) / 2;
      let c1 = hi - gr * (hi - lo), c2 = lo + gr * (hi - lo);
      let f1 = err(c1), f2 = err(c2);
      for (let it = 0; it < cand.iters; it++) {
        if (f1 < f2) { hi = c2; c2 = c1; f2 = f1; c1 = hi - gr * (hi - lo); f1 = err(c1); }
        else { lo = c1; c1 = c2; f1 = f2; c2 = lo + gr * (hi - lo); f2 = err(c2); }
      }
      const e = Math.min(f1, f2);
      if (!best || e < best.err) {
        const plant = { a, b: Math.exp(f1 < f2 ? c1 : c2), d };
        best = { plant, err: e, fit: frfFitPercent(meas, idx, modelFrf(plant, c, f, fs).T) };
      }
    }
  }
  return best;
}
