// Прогон цепочки фильтров по записанному логу.
//
// Фильтры в полётнике работают на частоте PID-цикла, а лог пишет каждый P interval-й
// цикл. Поэтому gyroUnfilt восстанавливается до частоты PID полосно-ограниченной
// интерполяцией (windowed sinc): то, что было ниже Найквиста лога, восстанавливается
// точно; то, что было выше, в лог не попало (и частично «отразилось» вниз) —
// это главный источник расхождения модели с бортом, его и меряет самопроверка.

import type { LogContext } from '../analysis/context';
import type { MaskSegment } from '../analysis/flightMask';
import { col } from '../decoder/decoder';
import { DTERM_SCALE, FilterChain, tpaFactor } from './chain';
import type { FilterContext, FilterParams } from './settings';

const HALF = 8; // полуширина ядра интерполяции, отсчётов лога

function kernels(R: number): Float64Array[] {
  const out: Float64Array[] = [];
  for (let p = 0; p < R; p++) {
    const k = new Float64Array(2 * HALF);
    const frac = p / R;
    let sum = 0;
    for (let j = -HALF + 1; j <= HALF; j++) {
      const t = j - frac;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const u = (t + HALF) / (2 * HALF); // окно Блэкмана на [−HALF, HALF]
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
      k[j + HALF - 1] = sinc * w;
      sum += sinc * w;
    }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    out.push(k);
  }
  return out;
}

export interface SimOptions {
  segments: MaskSegment[];
  warmupS?: number;
  /** считать D-term (с Kd и TPA) */
  dterm?: boolean;
}

export interface SimResult {
  /** отфильтрованное гиро по осям, на частоте лога; NaN вне участков */
  gyro: Float32Array[];
  /** D-term в единицах PID (как axisD), NaN вне участков; null — не считали */
  dterm: Float32Array[] | null;
  covered: Uint8Array;
  /** центры динамических нотчей [axis][p] на частоте лога */
  dynHz: Float32Array[][];
  /** срез gyro LPF1 во времени (0 — выкл.) */
  lpf1Hz: Float32Array;
  /** во сколько раз частота PID выше частоты лога */
  upsample: number;
  /** сколько отсчётов гиро усредняется на один PID-цикл */
  gyroAvg: number;
  ms: number;
}

/** участки для симуляции: не больше maxS секунд, равномерно по полёту */
export function chooseSegments(ctx: LogContext, segs: MaskSegment[], maxS: number, chunkS = 4): MaskSegment[] {
  const chunk = Math.max(16, Math.round(chunkS * ctx.fs));
  const pieces: MaskSegment[] = [];
  for (const s of segs) for (let a = s.i0; a < s.i1; a += chunk) pieces.push({ i0: a, i1: Math.min(s.i1, a + chunk) });
  const total = pieces.reduce((t, s) => t + s.i1 - s.i0, 0);
  const limit = Math.round(maxS * ctx.fs);
  if (total <= limit) return pieces;
  const step = total / limit;
  const out: MaskSegment[] = [];
  let acc = 0;
  for (let i = 0; i < pieces.length; i++) {
    if (i >= acc) {
      out.push(pieces[i]);
      acc += step;
    }
  }
  return out;
}

function interp(x: ArrayLike<number>, k: number, ker: Float64Array): number {
  const n = x.length;
  let s = 0;
  for (let j = -HALF + 1; j <= HALF; j++) {
    const idx = Math.min(n - 1, Math.max(0, k + j));
    s += x[idx] * ker[j + HALF - 1];
  }
  return s;
}

export function simulate(ctx: LogContext, p: FilterParams, fc: FilterContext, opts: SimOptions): SimResult {
  const t0 = performance.now();
  const n = ctx.n;
  const pidHz = 1e6 / fc.pidLooptimeUs;
  const ratio = pidHz / ctx.fs;
  const R = Math.abs(ratio - Math.round(ratio)) < 0.01 ? Math.max(1, Math.round(ratio)) : 1;
  // при pid_process_denom > 1 гиро опрашивается чаще PID: на вход фильтров идёт
  // среднее D последних отсчётов гиро (gyro.c, sampleSum/sampleCount), а в лог
  // gyroUnfilt пишется последний отсчёт. Восстанавливаем сигнал на частоте гиро.
  const D = Math.max(1, Math.round(fc.gyroLooptimeUs > 0 ? fc.pidLooptimeUs / fc.gyroLooptimeUs : 1));
  const Rg = R * D;
  const K = kernels(Rg);
  const gu = [0, 1, 2].map((a) => col(ctx.log, `gyroUnfilt[${a}]`) ?? col(ctx.log, `gyroADC[${a}]`)!);
  const motors = ctx.motorCount;
  const mHz = ctx.motorHzEach;
  const thr = ctx.thrPct;
  const warm = Math.round((opts.warmupS ?? 0.6) * ctx.fs);
  const withD = !!opts.dterm;
  const kd = fc.dGain.map((d) => d * DTERM_SCALE);

  const gyro = [0, 1, 2].map(() => new Float32Array(n).fill(NaN));
  const dterm = withD ? [0, 1, 2].map(() => new Float32Array(n).fill(NaN)) : null;
  const covered = new Uint8Array(n);
  const lpf1Hz = new Float32Array(n);
  let dynCount = 0;

  const segs = [...opts.segments].sort((a, b) => a.i0 - b.i0);
  // соседние участки симулируем одним проходом, если прогрев их перекрывает
  const runs: { from: number; i0: number; i1: number; parts: MaskSegment[] }[] = [];
  for (const s of segs) {
    const from = Math.max(0, s.i0 - warm);
    const last = runs[runs.length - 1];
    if (last && from <= last.i1) {
      last.i1 = Math.max(last.i1, s.i1);
      last.parts.push(s);
    } else runs.push({ from, i0: s.i0, i1: s.i1, parts: [s] });
  }

  let dynHz: Float32Array[][] = [];
  const outG = new Float64Array(3);
  const outD = new Float64Array(3);
  const gin = new Float64Array(3);
  const min = new Float64Array(Math.max(1, motors));

  for (const run of runs) {
    const chain = new FilterChain(p, fc, motors);
    if (!dynHz.length) {
      dynCount = chain.dyn.enabled ? chain.dyn.count : 0;
      dynHz = [0, 1, 2].map(() => Array.from({ length: dynCount }, () => new Float32Array(n).fill(NaN)));
    }
    const inPart = new Uint8Array(run.i1 - run.from);
    for (const s of run.parts) for (let i = s.i0; i < s.i1; i++) inPart[i - run.from] = 1;
    for (let k = run.from; k < run.i1; k++) {
      const th = thr[k] / 100;
      for (let ph = 0; ph < R; ph++) {
        // вход на PID-шаге k + ph/R
        for (let a = 0; a < 3; a++) {
          let acc = 0;
          for (let d = 0; d < D; d++) {
            // отсчёт гиро с номером (ph·D − d) относительно кадра k
            let q = ph * D - d, kk = k;
            while (q < 0) { q += Rg; kk--; }
            acc += q === 0 ? gu[a][Math.max(0, kk)] : interp(gu[a], kk, K[q]);
          }
          gin[a] = acc / D;
        }
        if (mHz) {
          const k1 = Math.min(n - 1, k + 1);
          const f = ph / R;
          for (let m = 0; m < motors; m++) min[m] = mHz[m][k] + (mHz[m][k1] - mHz[m][k]) * f;
        }
        chain.step(gin, min, th, outG, withD ? outD : null);
        if (ph === 0 && inPart[k - run.from]) {
          covered[k] = 1;
          for (let a = 0; a < 3; a++) gyro[a][k] = outG[a];
          if (dterm) {
            const tf = tpaFactor(th, fc);
            for (let a = 0; a < 3; a++) dterm[a][k] = outD[a] * kd[a] * tf;
          }
          lpf1Hz[k] = chain.lpf1Hz;
          for (let a = 0; a < 3; a++) for (let q = 0; q < dynCount; q++) dynHz[a][q][k] = chain.dyn.center[a][q];
        }
      }
    }
  }
  return { gyro, dterm, covered, dynHz, lpf1Hz, upsample: R, gyroAvg: D, ms: performance.now() - t0 };
}
