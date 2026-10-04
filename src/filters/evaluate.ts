// Оценка цепочки фильтров на логе: самопроверка модели (текущие настройки →
// записанный gyroADC), спектры гиро и D-term после фильтров, АЧХ/ФЧХ и задержка
// в операционной точке полёта. Используется и для текущих, и для предлагаемых настроек.

import cfg from '../config/analysis.json';
import type { LogContext } from '../analysis/context';
import { MaskSegment, runs } from '../analysis/flightMask';
import type { Burst } from '../analysis/noise';
import { col } from '../decoder/decoder';
import { nextPow2 } from '../dsp/fft';
import { bandRms, toDb, welch } from '../dsp/spectrum';
import { FilterChain, OperatingPoint } from './chain';
import { Filter, cmul } from './primitives';
import { FilterContext, FilterParams } from './settings';
import { SimResult, chooseSegments, simulate } from './simulate';

export interface Response {
  /** частоты, Гц */
  freqs: Float32Array;
  gyroMagDb: Float32Array;
  /** фазовая задержка, мс */
  gyroDelayMs: Float32Array;
  /** гиро + D-фильтры (без самой производной) */
  dtermMagDb: Float32Array;
  dtermDelayMs: Float32Array;
}

export interface FilterEval {
  params: FilterParams;
  describe: { gyro: string[]; dterm: string[] };
  /** СПМ после фильтров, дБ: гиро по 3 осям, D-term по ролл/питч */
  gyroDb: Float32Array[];
  dtermDb: Float32Array[];
  rmsGyro: number[];
  rmsDterm: number[];
  response: Response;
  delay: { gyro: Record<string, number>; dterm: Record<string, number> };
  /** вклад звеньев в задержку на 100 Гц, мс (RPM-нотчи суммарно) */
  breakdown: { name: string; ms: number }[];
  op: OperatingPoint;
  ms: number;
}

export type ModelStatus = 'green' | 'yellow' | 'red';

export interface Validation {
  /** «форма совпадает на X %» по осям: доля срезанного фильтрами, которую модель воспроизвела */
  match: number[];
  errRms: number[];
  removedRms: number[];
  /** средний модуль разницы спектров модели и лога выше 50 Гц, дБ */
  spectralDb: number[];
  dCorr: (number | null)[];
  dGain: (number | null)[];
  status: ModelStatus;
  /** почему не зелёный — ключ для текста */
  reason: 'ok' | 'low-rate' | 'mismatch' | 'no-unfilt' | 'old-fw' | 'no-data';
  logHz: number;
  pidHz: number;
}

export interface FilterBaseline {
  fs: number;
  df: number;
  n: number;
  windows: number;
  seconds: number;
  segments: MaskSegment[];
  loggedUnfiltDb: Float32Array[];
  loggedGyroDb: Float32Array[];
  loggedDtermDb: Float32Array[];
  loggedRmsGyro: number[];
  loggedRmsDterm: number[];
  current: FilterEval;
  validation: Validation;
}

const Q_FLOOR2 = 1 / 12; // дисперсия округления значения до целого в логе

const DELAY_POINTS = [50, 100, 150];

/** СПМ белого шума округления до целого, (°/с)²/Гц, односторонняя */
export const quantFloorPsd = (fs: number): number => Q_FLOOR2 / (fs / 2);

/** чистые участки: маска полёта без всплесков (с запасом) */
export function cleanSegments(ctx: LogContext, mask: Uint8Array, bursts: Burst[]): MaskSegment[] {
  const m = Uint8Array.from(mask);
  for (const b of bursts) for (let i = 0; i < ctx.n; i++) if (ctx.tSec[i] >= b.t0 - 0.3 && ctx.tSec[i] <= b.t1 + 0.3) m[i] = 0;
  return runs(m).filter((s) => s.i1 - s.i0 >= ctx.fs * 0.5);
}

function windowsOf(covered: Uint8Array, N: number): number[] {
  const out: number[] = [];
  let s = 0;
  while (s + N <= covered.length) {
    let bad = -1;
    for (let i = s + N - 1; i >= s; i--) if (!covered[i]) { bad = i; break; }
    if (bad < 0) { out.push(s); s += N / 2; } else s = bad + 1;
  }
  return out;
}

const dbOf = (p: { psd: Float64Array }): Float32Array => Float32Array.from(p.psd, toDb);

function median(a: number[]): number {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** частотная характеристика и фазовая задержка цепочки звеньев */
function chainResponse(gyro: Filter[], dterm: Filter[], dT: number, maxHz: number): Response {
  const step = 1;
  const nF = Math.floor(maxHz / step);
  const freqs = new Float32Array(nF);
  const gm = new Float32Array(nF), gd = new Float32Array(nF), dm = new Float32Array(nF), dd = new Float32Array(nF);
  let gPrev = 0, dPrev = 0, gUnw = 0, dUnw = 0;
  for (let i = 0; i < nF; i++) {
    const f = (i + 1) * step;
    freqs[i] = f;
    let h: [number, number] = [1, 0];
    for (const s of gyro) h = cmul(h, s.response(f, dT));
    let hd = h;
    for (const s of dterm) hd = cmul(hd, s.response(f, dT));
    const pg = Math.atan2(h[1], h[0]);
    const pd = Math.atan2(hd[1], hd[0]);
    // развёртка фазы
    let dg = pg - gPrev; while (dg > Math.PI) dg -= 2 * Math.PI; while (dg < -Math.PI) dg += 2 * Math.PI;
    let ddp = pd - dPrev; while (ddp > Math.PI) ddp -= 2 * Math.PI; while (ddp < -Math.PI) ddp += 2 * Math.PI;
    gUnw = i === 0 ? pg : gUnw + dg;
    dUnw = i === 0 ? pd : dUnw + ddp;
    gPrev = pg; dPrev = pd;
    gm[i] = 20 * Math.log10(Math.max(1e-9, Math.hypot(h[0], h[1])));
    dm[i] = 20 * Math.log10(Math.max(1e-9, Math.hypot(hd[0], hd[1])));
    gd[i] = (-gUnw / (2 * Math.PI * f)) * 1000;
    dd[i] = (-dUnw / (2 * Math.PI * f)) * 1000;
  }
  return { freqs, gyroMagDb: gm, gyroDelayMs: gd, dtermMagDb: dm, dtermDelayMs: dd };
}

/** операционная точка полёта: медианы газа, оборотов моторов, центров дин. нотчей */
function operatingPoint(ctx: LogContext, segs: MaskSegment[], sim: SimResult): OperatingPoint {
  const thr: number[] = [];
  const mh: number[][] = Array.from({ length: ctx.motorCount }, () => []);
  for (const s of segs) for (let i = s.i0; i < s.i1; i += 8) {
    thr.push(ctx.thrPct[i] / 100);
    if (ctx.motorHzEach) for (let m = 0; m < ctx.motorCount; m++) mh[m].push(ctx.motorHzEach[m][i]);
  }
  const dyn = sim.dynHz.map((axis) => axis.map((arr) => {
    const v: number[] = [];
    for (const s of segs) for (let i = s.i0; i < s.i1; i += 8) if (Number.isFinite(arr[i])) v.push(arr[i]);
    return median(v);
  }));
  return { throttle: median(thr) || 0.3, motorHz: mh.map((a) => median(a) || 0), dynNotch: dyn };
}

export function evaluate(ctx: LogContext, p: FilterParams, fc: FilterContext, segs: MaskSegment[], N: number, op?: OperatingPoint): { ev: FilterEval; sim: SimResult } {
  const t0 = performance.now();
  const sim = simulate(ctx, p, fc, { segments: segs, dterm: true });
  const win = windowsOf(sim.covered, N);
  const fs = ctx.fs;
  const nyq = fs / 2;
  const gyroDb: Float32Array[] = [], dtermDb: Float32Array[] = [];
  const rmsGyro: number[] = [], rmsDterm: number[] = [];
  for (let a = 0; a < 3; a++) {
    const pg = welch(nanToZero(sim.gyro[a]), fs, N, win);
    gyroDb.push(dbOf(pg));
    rmsGyro.push(bandRms(pg, cfg.noise.bandLowHz, nyq));
    if (a < 2 && sim.dterm) {
      const pd = welch(nanToZero(sim.dterm[a]), fs, N, win);
      dtermDb.push(dbOf(pd));
      rmsDterm.push(bandRms(pd, cfg.noise.dtermBandLowHz, nyq));
    }
  }
  const chain = new FilterChain(p, fc, ctx.motorCount);
  const point = op ?? operatingPoint(ctx, segs, sim);
  // центры дин. нотчей для новых настроек — из их собственной симуляции
  const opHere: OperatingPoint = { ...point, dynNotch: operatingPoint(ctx, segs, sim).dynNotch };
  const sec = chain.sections(opHere, 0);
  const pidNyq = 1e6 / fc.pidLooptimeUs / 2;
  const response = chainResponse(sec.gyro.map((s) => s.f), sec.dterm.map((s) => s.f), fc.pidLooptimeUs * 1e-6, Math.min(1000, pidNyq * 0.98));
  const at = (arr: Float32Array, f: number): number => arr[Math.max(0, Math.min(arr.length - 1, Math.round(f) - 1))];
  const delay = {
    gyro: Object.fromEntries(DELAY_POINTS.map((f) => [String(f), at(response.gyroDelayMs, f)])),
    dterm: Object.fromEntries(DELAY_POINTS.map((f) => [String(f), at(response.dtermDelayMs, f)])),
  };
  const bd = new Map<string, number>();
  const dT = fc.pidLooptimeUs * 1e-6;
  for (const s of [...sec.gyro, ...sec.dterm]) {
    const [r, i] = s.f.response(100, dT);
    bd.set(s.name, (bd.get(s.name) ?? 0) + (-Math.atan2(i, r) / (2 * Math.PI * 100)) * 1000);
  }
  const breakdown = [...bd].map(([name, ms]) => ({ name, ms }));
  return {
    ev: { params: p, describe: chain.describe(), gyroDb, dtermDb, rmsGyro, rmsDterm, response, delay, breakdown, op: opHere, ms: performance.now() - t0 },
    sim,
  };
}

function nanToZero(a: Float32Array): Float32Array {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = Number.isFinite(a[i]) ? a[i] : 0;
  return o;
}

export function buildBaseline(ctx: LogContext, mask: Uint8Array, bursts: Burst[], p: FilterParams, fc: FilterContext): { base: FilterBaseline; sim: SimResult } {
  const F = cfg.filters;
  const segsAll = cleanSegments(ctx, mask, bursts);
  const segs = chooseSegments(ctx, segsAll, F.maxSimSeconds);
  const N = Math.min(4096, nextPow2(ctx.fs));
  const { ev, sim } = evaluate(ctx, p, fc, segs, N);
  const win = windowsOf(sim.covered, N);
  const fs = ctx.fs, nyq = fs / 2;
  const loggedUnfiltDb: Float32Array[] = [], loggedGyroDb: Float32Array[] = [], loggedDtermDb: Float32Array[] = [];
  const loggedRmsGyro: number[] = [], loggedRmsDterm: number[] = [];
  const match: number[] = [], errRms: number[] = [], removedRms: number[] = [], spectralDb: number[] = [];
  const dCorr: (number | null)[] = [], dGain: (number | null)[] = [];
  for (let a = 0; a < 3; a++) {
    const gl = col(ctx.log, `gyroADC[${a}]`)!;
    const gu = col(ctx.log, `gyroUnfilt[${a}]`) ?? gl;
    const pl = welch(gl, fs, N, win);
    loggedGyroDb.push(dbOf(pl));
    loggedUnfiltDb.push(dbOf(welch(gu, fs, N, win)));
    loggedRmsGyro.push(bandRms(pl, cfg.noise.bandLowHz, nyq));
    // форма сигнала
    let e = 0, ref = 0, c = 0;
    for (let i = 0; i < ctx.n; i++) {
      if (!sim.covered[i]) continue;
      const d = sim.gyro[a][i] - gl[i];
      const q = gu[i] - gl[i];
      e += d * d; ref += q * q; c++;
    }
    const err2 = c ? e / c : NaN, rem = c ? Math.sqrt(ref / c) : NaN;
    errRms.push(Math.sqrt(err2));
    removedRms.push(rem);
    match.push(rem > 0 ? Math.max(0, 100 * (1 - Math.sqrt(Math.max(0, err2 - Q_FLOOR2)) / rem)) : NaN);
    // спектр выше 50 Гц: средний модуль разницы в дБ (сглаживаем по 5 Гц). К модели
    // добавляем белый шум округления лога (1/12 на отсчёт) — он есть в записанном gyroADC
    const simDb = ev.gyroDb[a], logDb = loggedGyroDb[a];
    const df = fs / N;
    const floor = quantFloorPsd(fs);
    let sd = 0, sn = 0;
    const w = Math.max(1, Math.round(5 / df));
    for (let k = Math.ceil(50 / df); k < Math.floor((nyq * 0.95) / df) - w; k += w) {
      let ps = 0, pl2 = 0;
      for (let j = 0; j < w; j++) { ps += Math.pow(10, simDb[k + j] / 10) + floor; pl2 += Math.pow(10, logDb[k + j] / 10); }
      sd += Math.abs(10 * Math.log10(ps / pl2)); sn++;
    }
    spectralDb.push(sn ? sd / sn : NaN);
    // D-term
    const dl = col(ctx.log, `axisD[${a}]`);
    if (a < 2 && dl && sim.dterm) {
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < ctx.n; i++) if (sim.covered[i]) { const x = sim.dterm[a][i], y = dl[i]; sxy += x * y; sxx += x * x; syy += y * y; }
      dCorr.push(sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null);
      dGain.push(sxx > 0 ? sxy / sxx : null);
      const pd = welch(dl, fs, N, win);
      loggedDtermDb.push(dbOf(pd));
      loggedRmsDterm.push(bandRms(pd, cfg.noise.dtermBandLowHz, nyq));
    } else if (a < 2) { dCorr.push(null); dGain.push(null); }
  }
  const worst = Math.min(...match.filter((x) => Number.isFinite(x)));
  let status: ModelStatus = worst >= F.matchGreen ? 'green' : worst >= F.matchRed ? 'yellow' : 'red';
  let reason: Validation['reason'] = status === 'green' ? 'ok' : ctx.fs < F.minGoodLogHz ? 'low-rate' : 'mismatch';
  if (!ctx.hasGyroUnfilt) { status = 'red'; reason = 'no-unfilt'; }
  if (ctx.fw.code && ctx.fw.code < 4_003_000) { status = 'red'; reason = 'old-fw'; }
  if (!win.length) { status = 'red'; reason = 'no-data'; }
  let seconds = 0;
  for (const s of segs) seconds += ctx.tSec[s.i1 - 1] - ctx.tSec[s.i0];
  return {
    base: {
      fs, df: fs / N, n: N, windows: win.length, seconds, segments: segs,
      loggedUnfiltDb, loggedGyroDb, loggedDtermDb, loggedRmsGyro, loggedRmsDterm,
      current: ev,
      validation: { match, errRms, removedRms, spectralDb, dCorr, dGain, status, reason, logHz: ctx.fs, pidHz: 1e6 / fc.pidLooptimeUs },
    },
    sim,
  };
}
