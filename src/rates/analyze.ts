// Рейты на записанном полёте: самопроверка формулы (записанный rcCommand → setpoint
// против записанного setpoint), гистограммы положения стиков, манёвры и точный
// пересчёт setpoint под новые рейты.
//
// Пересчёт: прошивка считает setpoint из rcCommand формулой рейтов и сглаживает
// его RC smoothing (PT3, rc.c / rc_smoothing). Новый setpoint =
//   записанный setpoint + PT3(сырой_новый − сырой_текущий).
// Фильтр линейный, поэтому на стоячем стике это точно, а в движении ошибка —
// только от неточно известной частоты сглаживания, применённой к разнице.

import cfg from '../config/analysis.json';
import { FLIGHT_MODES, bitNames } from '../decoder/constants';
import { Column, col } from '../decoder/decoder';
import { nums } from '../decoder/header';
import { LogContext } from '../analysis/context';
import { Lowpass, LPF_TYPE } from '../filters/primitives';
import { RateProfile, deflection, maxRate, setpointFor } from './rates';

const C = cfg.rates;

export interface RateCheckAxis {
  /** % проверенных кадров, где формула дала записанный setpoint */
  matchPct: number;
  samples: number;
  /** СКЗ ошибки на проверенных кадрах, °/с */
  rmsErr: number;
}

export interface RateCheck {
  axes: RateCheckAxis[];
  status: 'green' | 'yellow' | 'red' | 'grey';
  reason: 'ok' | 'mismatch' | 'no-data' | 'no-fields';
  /** секунд в режимах, где setpoint считает не формула рейтов (ANGLE, HEADFREE…) */
  nonRateS: number;
  nonRateModes: string[];
}

export interface StickUsage {
  /** доли времени, % */
  centerPct: number;
  fullPct: number;
  /** перцентили |отклонения| 0…1 */
  p50: number;
  p95: number;
  p99: number;
  /** 99-й перцентиль |записанного setpoint|, °/с */
  sp99: number;
  /** максимальный |записанный setpoint| */
  spMax: number;
}

export interface Maneuver {
  axis: number;
  t0: number;
  t1: number;
  tPeak: number;
  /** пик |отклонения стика| 0…1 */
  stick: number;
  /** пик записанного setpoint (со знаком), °/с */
  spWas: number;
  /** пик достигнутой угловой скорости (gyro), °/с */
  gyroPeak: number;
  /** угол поворота по записанному setpoint и по гироскопу, ° */
  angleWas: number;
  angleGyro: number;
}

export interface ManeuverEval {
  spNew: number;
  angleNew: number;
}

export interface RatesBase {
  profile: RateProfile;
  /** частота сглаживания setpoint (RC smoothing), Гц; 0 — без сглаживания */
  smoothHz: number;
  check: RateCheck;
  /** гистограммы |отклонения| (ролл, питч, яв) и газа, % времени в бине */
  hist: { binPct: number; axes: number[][]; throttle: number[] };
  usage: StickUsage[];
  maneuvers: Maneuver[];
  seconds: number;
}

export interface RatesEval {
  maneuvers: ManeuverEval[];
  /** 99-й перцентиль и максимум |нового setpoint| на чистом полёте */
  sp99: number[];
  spMax: number[];
}

/** кадры, где setpoint задают не рейты (ANGLE, HEADFREE, GPS Rescue…) */
function nonRateMask(c: LogContext): { mask: Uint8Array; seconds: number; modes: string[] } {
  const { log, n, tSec } = c;
  const mask = new Uint8Array(n);
  const S = log.slowFieldNames;
  const iMode = S.indexOf('flightModeFlags');
  const bad = new Set(C.nonRateModes);
  const seen = new Set<string>();
  let cnt = 0;
  if (iMode >= 0 && log.slow.length) {
    const t0 = log.time[0];
    let i = 0;
    for (let k = 0; k < log.slow.length; k++) {
      const r = log.slow[k];
      const a = (r.t - t0) / 1e6;
      const b = k + 1 < log.slow.length ? (log.slow[k + 1].t - t0) / 1e6 : Infinity;
      const hit = bitNames(r.v[iMode], FLIGHT_MODES).filter((m) => bad.has(m));
      if (!hit.length) continue;
      hit.forEach((m) => seen.add(m));
      while (i < n && tSec[i] < a) i++;
      for (let j = i; j < n && tSec[j] < b; j++) { mask[j] = 1; cnt++; }
    }
  }
  return { mask, seconds: cnt / c.fs, modes: [...seen] };
}

/** частота сглаживания setpoint: кандидаты из заголовка, выбираем лучшую по совпадению с логом */
function smoothCandidates(H: Record<string, string>): number[] {
  if (H.rc_smoothing !== undefined && Number(H.rc_smoothing) === 0) return [0];
  const out = new Set<number>();
  for (const k of Object.keys(H)) if (k.startsWith('rc_smoothing_active_cutoffs')) nums(H, k).forEach((v) => { if (v > 0) out.add(v); });
  return out.size ? [...out] : [0];
}

function pt3(hz: number, fs: number): { apply(x: number): number } {
  if (!hz) return { apply: (x: number) => x };
  return new Lowpass(LPF_TYPE.PT3, hz, 1e6 / fs);
}

function quantile(sorted: Float32Array, q: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

export interface RatesWork {
  base: RatesBase;
  /** сырой setpoint текущих рейтов (до сглаживания) по осям */
  rawOld: Float32Array[];
  use: Uint8Array;
}

export function buildRatesBase(c: LogContext, flightMask: Uint8Array, profile: RateProfile): RatesWork {
  const { n, fs, tSec, log } = c;
  const rc: (Column | null)[] = [0, 1, 2].map((a) => col(log, `rcCommand[${a}]`));
  const sp: (Column | null)[] = [0, 1, 2].map((a) => col(log, `setpoint[${a}]`));
  const gy: (Column | null)[] = [0, 1, 2].map((a) => col(log, `gyroADC[${a}]`));
  const nr = nonRateMask(c);
  // кадры для анализа: чистый полёт, вне «не-рейтовых» режимов
  const use = new Uint8Array(n);
  let useN = 0;
  for (let i = 0; i < n; i++) if (flightMask[i] && !nr.mask[i]) { use[i] = 1; useN++; }

  const rawOld = [0, 1, 2].map((a) => {
    const r = new Float32Array(n);
    const rcA = rc[a];
    if (rcA) for (let i = 0; i < n; i++) r[i] = setpointFor(profile, a, deflection(profile, a, rcA[i]));
    return r;
  });

  // --- сглаживание: какая частота из заголовка лучше объясняет записанный setpoint
  const cands = smoothCandidates(log.header);
  let smoothHz = cands[0];
  if (cands.length > 1 && sp[0]) {
    let best = Infinity;
    for (const hz of cands) {
      let se = 0;
      for (let a = 0; a < 3; a++) {
        const s = sp[a];
        if (!s) continue;
        const f = pt3(hz, fs);
        for (let i = 0; i < n; i++) {
          const y = f.apply(rawOld[a][i]);
          if (use[i]) se += (y - s[i]) ** 2;
        }
      }
      if (se < best) { best = se; smoothHz = hz; }
    }
  }

  // --- самопроверка формулы на «стоячем» стике
  const steady = Math.max(1, Math.round((C.steadyMs / 1000) * fs));
  const checkAxes: RateCheckAxis[] = [0, 1, 2].map((a) => {
    const rcA = rc[a], s = sp[a];
    if (!rcA || !s) return { matchPct: NaN, samples: 0, rmsErr: NaN };
    let lastChange = 0, ok = 0, cnt = 0, se = 0;
    for (let i = 1; i < n; i++) {
      if (rcA[i] !== rcA[i - 1]) lastChange = i;
      if (!use[i] || i - lastChange < steady) continue;
      if (Math.abs(deflection(profile, a, rcA[i])) < C.minDeflection) continue;
      const e = rawOld[a][i] - s[i];
      const tol = Math.max(C.matchAbsDps, (Math.abs(s[i]) * C.matchRelPct) / 100);
      if (Math.abs(e) <= tol) ok++;
      se += e * e;
      cnt++;
    }
    return { matchPct: cnt ? (ok / cnt) * 100 : NaN, samples: cnt, rmsErr: cnt ? Math.sqrt(se / cnt) : NaN };
  });
  let reason: RateCheck['reason'] = 'ok';
  let status: RateCheck['status'] = 'green';
  if (!rc[0] || !sp[0]) { reason = 'no-fields'; status = 'grey'; }
  else {
    const valid = checkAxes.filter((x) => x.samples >= C.minCheckSamples);
    if (!valid.length) { reason = 'no-data'; status = 'grey'; }
    else {
      const worst = Math.min(...valid.map((x) => x.matchPct));
      status = worst >= C.matchGreen ? 'green' : worst >= C.matchRed ? 'yellow' : 'red';
      if (status !== 'green') reason = 'mismatch';
    }
  }

  // --- гистограммы и использование стиков
  const bins = Math.round(100 / C.histBinPct);
  const hist = { binPct: C.histBinPct, axes: [] as number[][], throttle: new Array(bins).fill(0) as number[] };
  const usage: StickUsage[] = [];
  for (let a = 0; a < 3; a++) {
    const hgram = new Array(bins).fill(0) as number[];
    const rcA = rc[a], s = sp[a];
    const defl = new Float32Array(useN);
    const sps = new Float32Array(useN);
    let k = 0, center = 0, full = 0, spMax = 0;
    for (let i = 0; i < n; i++) {
      if (!use[i]) continue;
      const d = rcA ? Math.abs(deflection(profile, a, rcA[i])) : 0;
      defl[k] = d;
      const v = s ? Math.abs(s[i]) : 0;
      sps[k++] = v;
      if (v > spMax) spMax = v;
      hgram[Math.min(bins - 1, Math.floor(d * bins))]++;
      if (d < C.centerDeflection) center++;
      if (d >= C.fullDeflection) full++;
    }
    hist.axes.push(hgram.map((x) => (useN ? (x / useN) * 100 : 0)));
    defl.sort();
    sps.sort();
    usage.push({
      centerPct: useN ? (center / useN) * 100 : NaN,
      fullPct: useN ? (full / useN) * 100 : NaN,
      p50: quantile(defl, 0.5), p95: quantile(defl, 0.95), p99: quantile(defl, 0.99),
      sp99: quantile(sps, 0.99), spMax,
    });
  }
  for (let i = 0; i < n; i++) if (use[i]) hist.throttle[Math.min(bins - 1, Math.floor((c.thrPct[i] / 100) * bins))]++;
  hist.throttle = hist.throttle.map((x) => (useN ? (x / useN) * 100 : 0));

  // --- манёвры: участки с |setpoint| у максимума рейтов
  const found: Maneuver[] = [];
  const merge = Math.round(C.maneuverMergeS * fs);
  for (let a = 0; a < 3; a++) {
    const s = sp[a], rcA = rc[a], g = gy[a];
    if (!s || !rcA) continue;
    const mr = maxRate(profile, a);
    const hi = C.maneuverPeakShare * mr, lo = C.maneuverEdgeShare * mr;
    let i = 0;
    while (i < n) {
      if (!use[i] || Math.abs(s[i]) < hi) { i++; continue; }
      const sign = Math.sign(s[i]);
      // расширяем до краёв (тот же знак, выше lo)
      let i0 = i, i1 = i;
      while (i0 > 0 && use[i0 - 1] && s[i0 - 1] * sign > lo) i0--;
      while (i1 + 1 < n && use[i1 + 1] && s[i1 + 1] * sign > lo) i1++;
      // склеиваем близкие в том же направлении
      let j = i1 + 1;
      while (j < n && j - i1 <= merge) {
        if (use[j] && s[j] * sign > hi) {
          i1 = j;
          while (i1 + 1 < n && use[i1 + 1] && s[i1 + 1] * sign > lo) i1++;
          j = i1 + 1;
        } else j++;
      }
      let spPeak = 0, stick = 0, gPeak = 0, angSp = 0, angG = 0, iPk = i0;
      for (let k = i0; k <= i1; k++) {
        if (Math.abs(s[k]) > Math.abs(spPeak)) { spPeak = s[k]; iPk = k; }
        stick = Math.max(stick, Math.abs(deflection(profile, a, rcA[k])));
        const dt = k > 0 ? tSec[k] - tSec[k - 1] : 1 / fs;
        angSp += s[k] * dt;
        if (g) {
          if (g[k] * sign > gPeak) gPeak = g[k] * sign;
          angG += g[k] * dt;
        }
      }
      found.push({ axis: a, t0: tSec[i0], t1: tSec[i1], tPeak: tSec[iPk], stick, spWas: spPeak, gyroPeak: gPeak * sign, angleWas: angSp, angleGyro: angG });
      i = i1 + 1;
    }
  }
  // самые сильные, потом по времени
  const maneuvers = found.sort((x, y) => Math.abs(y.angleWas) - Math.abs(x.angleWas)).slice(0, C.maneuverMax).sort((x, y) => x.t0 - y.t0);

  return {
    base: {
      profile, smoothHz,
      check: { axes: checkAxes, status, reason, nonRateS: nr.seconds, nonRateModes: nr.modes },
      hist, usage, maneuvers, seconds: useN / fs,
    },
    rawOld, use,
  };
}

/** новый setpoint под рейты p: записанный + сглаженная разница сырых (см. шапку) */
export function newSetpoint(c: LogContext, w: RatesWork, p: RateProfile): Float32Array[] {
  const { n, log, fs } = c;
  return [0, 1, 2].map((a) => {
    const out = new Float32Array(n);
    const rcA = col(log, `rcCommand[${a}]`), s = col(log, `setpoint[${a}]`);
    if (!rcA || !s) return out;
    const f = pt3(w.base.smoothHz, fs);
    for (let i = 0; i < n; i++) {
      const raw = setpointFor(p, a, deflection(p, a, rcA[i]));
      out[i] = s[i] + f.apply(raw - w.rawOld[a][i]);
    }
    return out;
  });
}

export function evalRates(c: LogContext, w: RatesWork, spNew: Float32Array[]): RatesEval {
  const { n, tSec } = c;
  const maneuvers = w.base.maneuvers.map((m) => {
    const arr = spNew[m.axis];
    let pk = 0, ang = 0;
    for (let i = 0; i < n; i++) {
      if (tSec[i] < m.t0) continue;
      if (tSec[i] > m.t1) break;
      if (Math.abs(arr[i]) > Math.abs(pk)) pk = arr[i];
      ang += arr[i] * (i > 0 ? tSec[i] - tSec[i - 1] : 0);
    }
    return { spNew: pk, angleNew: ang };
  });
  const sp99: number[] = [], spMax: number[] = [];
  for (let a = 0; a < 3; a++) {
    const v: number[] = [];
    let mx = 0;
    for (let i = 0; i < n; i++) if (w.use[i]) { const x = Math.abs(spNew[a][i]); v.push(x); if (x > mx) mx = x; }
    const s = Float32Array.from(v).sort();
    sp99.push(quantile(s, 0.99));
    spMax.push(mx);
  }
  return { maneuvers, sp99, spMax };
}
