// Шумы: спектры гироскопа до/после фильтров и D-term, пики, их природа
// (гармоника моторов / резонанс рамы), спектрограммы «частота × газ» и «× время».
// Порт и развитие bb-tools/noise.js.

import cfg from '../config/analysis.json';
import { col } from '../decoder/decoder';
import { nextPow2 } from '../dsp/fft';
import { Peak, Psd, Spectrogram, bandRms, findPeaks, segmentStarts, throttleSpectrogram, timeSpectrogram, welch } from '../dsp/spectrum';
import { LogContext } from './context';
import { FlightMask } from './flightMask';

export const AXES = ['roll', 'pitch', 'yaw'] as const;

export type PeakKind = 'motor' | 'frame' | 'unknown';

export interface ClassifiedPeak extends Peak {
  kind: PeakKind;
  /** номер гармоники моторов (для kind = motor) */
  harmonic?: number;
  /** насколько частота пика «ездит» с газом: коэф. вариации по бинам газа */
  freqCv?: number;
  /** отношение частоты пика к частоте моторов в бинах газа: коэф. вариации */
  ratioCv?: number;
  /** полоса, где пик заметен, Гц */
  bandLo: number;
  bandHi: number;
}

export interface AxisNoise {
  axis: number;
  unfilt: Psd | null;
  filt: Psd;
  dterm: Psd | null;
  /** СКЗ в полосе [bandLow, Найквист], °/с */
  rmsUnfilt: number | null;
  rmsFilt: number;
  /** подавление фильтрами в этой полосе, дБ */
  reductionDb: number | null;
  /** СКЗ D-term выше dtermBandLow (единицы PID) */
  rmsDterm: number | null;
  /** СКЗ после фильтров в полосе 20–80 Гц — колебания в полосе работы PID */
  rmsMid: number;
  /** окно «ниже 100 Гц» как в PIDtoolbox: самый высокий уровень после фильтров и его частота */
  sub100: Sub100 | null;
  peaks: ClassifiedPeak[];
}

export interface Sub100 {
  /** самый заметный узкий пик над трендом спектра (дБ — 10·lg СПМ, шкала PIDtoolbox) */
  peakHz: number;
  peakDb: number;
  /** насколько пик выше тренда (прямая в осях lg f — дБ), дБ */
  peakProm: number;
  zone: 'loose' | 'electric' | 'pid';
  /** средний уровень в полосе bandFromHz…100 Гц — широкий подъём от PID */
  bandDb: number;
}

export interface Burst {
  t0: number;
  t1: number;
  /** во сколько раз сегмент «громче» медианного (по амплитуде, СКЗ) */
  ratio: number;
}

export interface NoiseResult {
  fs: number;
  nyquist: number;
  n: number;
  segments: number;
  seconds: number;
  axes: AxisNoise[];
  /** медиана частоты моторов в маске, Гц */
  motorHzMedian: number | null;
  /** спектрограммы по осям: газ — до фильтров (или после, если нет gyroUnfilt) */
  thrSpec: { unfilt: Spectrogram | null; filt: Spectrogram }[];
  timeSpec: { unfilt: Spectrogram | null; filt: Spectrogram }[];
  degraded: string | null;
  /** сегменты-выбросы (удары, срывы), исключённые из спектров */
  bursts: Burst[];
}

export function analyzeNoise(ctx: LogContext, fm: FlightMask): NoiseResult {
  const C = cfg.noise;
  const fs = ctx.fs;
  const nyq = fs / 2;
  const N = Math.min(4096, nextPow2(fs)); // ≈1 Гц разрешения
  const gyroF = [0, 1, 2].map((a) => col(ctx.log, `gyroADC[${a}]`)!);
  const bursts: Burst[] = [];
  const starts = rejectBursts(segmentStarts(fm.mask, ctx.n, N, N / 2), N, gyroF, ctx, bursts);
  const Ns = nextPow2(fs / 4); // 0.25 с для спектрограмм → ~4 Гц
  const startsS = rejectBursts(segmentStarts(fm.mask, ctx.n, Ns, Ns / 2), Ns, gyroF, ctx, null);

  let motorHzMedian: number | null = null;
  if (ctx.motorHz) {
    const v: number[] = [];
    for (let i = 0; i < ctx.n; i += 8) if (fm.mask[i] && ctx.motorHz[i] > 0) v.push(ctx.motorHz[i]);
    if (v.length) {
      v.sort((a, b) => a - b);
      motorHzMedian = v[Math.floor(v.length / 2)];
    }
  }

  const axes: AxisNoise[] = [];
  const thrSpec: NoiseResult['thrSpec'] = [];
  const timeSpec: NoiseResult['timeSpec'] = [];

  for (let a = 0; a < 3; a++) {
    const gu = ctx.hasGyroUnfilt ? col(ctx.log, `gyroUnfilt[${a}]`) : null;
    const gf = col(ctx.log, `gyroADC[${a}]`)!;
    const d = col(ctx.log, `axisD[${a}]`);
    const unfilt = gu ? welch(gu, fs, N, starts) : null;
    const filt = welch(gf, fs, N, starts);
    const dterm = d ? welch(d, fs, N, starts) : null;
    const rmsUnfilt = unfilt ? bandRms(unfilt, C.bandLowHz, nyq) : null;
    const rmsFilt = bandRms(filt, C.bandLowHz, nyq);
    const rmsDterm = dterm && a < 2 ? bandRms(dterm, C.dtermBandLowHz, nyq) : null;

    const ts = { unfilt: gu ? throttleSpectrogram(gu, ctx.thrPct, ctx.motorHz, fs, Ns, startsS) : null, filt: throttleSpectrogram(gf, ctx.thrPct, ctx.motorHz, fs, Ns, startsS) };
    thrSpec.push(ts);
    timeSpec.push({
      unfilt: gu ? timeSpectrogram(gu, ctx.log.time, ctx.motorHz, fs, Ns, ctx.n) : null,
      filt: timeSpectrogram(gf, ctx.log.time, ctx.motorHz, fs, Ns, ctx.n),
    });

    const base = unfilt ?? filt;
    const raw = base.segments ? findPeaks(base, 50, nyq * 0.97, 6, C.peakMinProminenceDb) : [];
    const peaks = raw.map((p) => classifyPeak(p, ts.unfilt ?? ts.filt, motorHzMedian));

    axes.push({
      axis: a, unfilt, filt, dterm, rmsUnfilt, rmsFilt,
      reductionDb: rmsUnfilt !== null && rmsFilt > 0 ? 20 * Math.log10(rmsUnfilt / rmsFilt) : null,
      rmsDterm, rmsMid: bandRms(filt, 20, 80), sub100: a < 2 && filt.segments ? sub100Of(filt) : null, peaks,
    });
  }

  let degraded: string | null = null;
  if (!ctx.hasGyroUnfilt) degraded = 'no-gyro-unfilt';

  return {
    fs, nyquist: nyq, n: N, segments: starts.length, seconds: fm.seconds, axes, motorHzMedian, thrSpec, timeSpec, degraded, bursts,
  };
}

/**
 * Отбраковка сегментов-выбросов: энергия первой разности гиро (≈ ВЧ-часть) по трём
 * осям; сегмент в cfg.noise.burstRatio раз громче медианного — удар, срыв или сбой.
 * Одно такое событие способно «перекрасить» средний спектр всего полёта.
 */
function rejectBursts(starts: number[], n: number, g: ArrayLike<number>[], ctx: LogContext, out: Burst[] | null): number[] {
  if (starts.length < 5) return starts;
  const e = starts.map((s) => {
    let acc = 0;
    for (const x of g) for (let i = s + 1; i < s + n; i++) { const d = x[i] - x[i - 1]; acc += d * d; }
    return acc / n;
  });
  const sorted = e.slice().sort((a, b) => a - b);
  const med = Math.max(sorted[Math.floor(sorted.length / 2)], 1e-6);
  const lim = cfg.noise.burstRatio * med;
  const kept: number[] = [];
  starts.forEach((s, k) => {
    if (e[k] <= lim) { kept.push(s); return; }
    if (!out) return;
    const t0 = ctx.tSec[s], t1 = ctx.tSec[Math.min(ctx.n - 1, s + n - 1)];
    const last = out[out.length - 1];
    const ratio = Math.sqrt(e[k] / med);
    if (last && t0 <= last.t1) { last.t1 = t1; last.ratio = Math.max(last.ratio, ratio); }
    else out.push({ t0, t1, ratio });
  });
  return kept;
}

/**
 * Природа пика: смотрим, как его частота ведёт себя по бинам газа.
 *  - отношение к частоте моторов постоянно и близко к целому → гармоника моторов;
 *  - частота почти не меняется с газом → резонанс рамы/конструкции;
 *  - иначе — неясно.
 */
export function classifyPeak(p: Peak, spec: Spectrogram, motorHzMedian: number | null): ClassifiedPeak {
  const C = cfg.noise;
  const out: ClassifiedPeak = { ...p, kind: 'unknown', bandLo: p.hz - p.widthHz / 2, bandHi: p.hz + p.widthHz / 2 };
  const freqs: number[] = [];
  const ratios: number[] = [];
  for (let r = 0; r < spec.rows; r++) {
    if (spec.counts[r] < 3) continue;
    const lo = Math.max(1, Math.floor((p.hz * 0.7) / spec.df));
    const hi = Math.min(spec.cols - 1, Math.ceil((p.hz * 1.3) / spec.df));
    let best = -Infinity, bi = -1;
    for (let k = lo; k <= hi; k++) {
      const v = spec.data[r * spec.cols + k];
      if (v > best) { best = v; bi = k; }
    }
    if (bi < 0) continue;
    const f = bi * spec.df;
    freqs.push(f);
    const m = spec.motorHz[r];
    if (Number.isFinite(m) && m > 10) ratios.push(f / m);
  }
  const cv = (a: number[]): number => {
    if (a.length < 3) return NaN;
    const mu = a.reduce((s, x) => s + x, 0) / a.length;
    const sd = Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / a.length);
    return sd / mu;
  };
  const fCv = cv(freqs);
  const rCv = cv(ratios);
  out.freqCv = Number.isFinite(fCv) ? fCv : undefined;
  out.ratioCv = Number.isFinite(rCv) ? rCv : undefined;
  if (freqs.length) {
    out.bandLo = Math.min(...freqs, out.bandLo);
    out.bandHi = Math.max(...freqs, out.bandHi);
  }

  if (motorHzMedian && motorHzMedian > 10) {
    const r = p.hz / motorHzMedian;
    const h = Math.round(r);
    const nearInt = h >= 1 && h <= 4 && Math.abs(r - h) <= C.motorHarmonicTolerance * h;
    // частота едет вместе с газом пропорционально моторам
    const tracksMotor = Number.isFinite(rCv) && rCv < 0.12 && (!Number.isFinite(fCv) || fCv > C.frameResonanceMaxCv);
    // «рядом с целой гармоникой» засчитываем, только если отношение к моторам
    // стабильнее самой частоты — иначе это совпадение по медиане
    const ratioBeatsFreq = !Number.isFinite(rCv) || !Number.isFinite(fCv) || rCv < fCv;
    if (tracksMotor || (nearInt && ratioBeatsFreq && !(Number.isFinite(fCv) && fCv < C.frameResonanceMaxCv))) {
      out.kind = 'motor';
      out.harmonic = Math.max(1, h);
      return out;
    }
  }
  if (Number.isFinite(fCv) && fCv < C.frameResonanceMaxCv && freqs.length >= 3) out.kind = 'frame';
  return out;
}

/**
 * Окно «ниже 100 Гц» (разметка админа чата Blackbox 2.0 на скриншотах PIDtoolbox): до ~15 Гц —
 * стики; 18–28 Гц — что-то болтается (антенна, камера); 30–45 Гц — электрика (конденсатор,
 * питание гиро); выше — моторы, пропвош и перерегулирование PID. Нормальный уровень после
 * фильтров −20…−40 дБ; выше sub100.warnDb — проблема (её не фильтруют, лечат механикой или
 * главным множителем).
 */
export function sub100Of(p: Psd): Sub100 {
  const C = cfg.noise.sub100;
  const half = Math.max(1, Math.round(C.smoothHz / p.df));
  const i0 = Math.ceil(C.fromHz / p.df), i1 = Math.floor(100 / p.df);
  const f: number[] = [], db: number[] = [];
  for (let i = i0; i <= i1; i++) {
    let s = 0, k = 0;
    for (let j = i - half; j <= i + half; j++) if (j > 0 && j < p.psd.length) { s += p.psd[j]; k++; }
    f.push(i * p.df);
    db.push(10 * Math.log10(Math.max(1e-12, s / k)));
  }
  // тренд: спектр после фильтров спадает с частотой (хвост стиков) — прямая МНК в осях lg f / дБ
  const x = f.map((v) => Math.log10(v));
  const mx = x.reduce((s, v) => s + v, 0) / x.length, my = db.reduce((s, v) => s + v, 0) / db.length;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (db[i] - my); sxx += (x[i] - mx) ** 2; }
  const k = sxx ? sxy / sxx : 0;
  let best = 0, bestR = -Infinity;
  for (let i = 0; i < x.length; i++) {
    const r = db[i] - (my + k * (x[i] - mx));
    if (r > bestR) { bestR = r; best = i; }
  }
  const hz = f[best];
  const zone = hz < C.looseMaxHz ? 'loose' : hz < C.electricMaxHz ? 'electric' : 'pid';
  const band = db.filter((_, i) => f[i] >= C.bandFromHz);
  const bandDb = 10 * Math.log10(band.reduce((s, v) => s + 10 ** (v / 10), 0) / Math.max(1, band.length));
  return { peakHz: hz, peakDb: db[best], peakProm: bestR, zone, bandDb };
}
