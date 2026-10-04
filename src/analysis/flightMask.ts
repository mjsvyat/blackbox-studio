// Маска «чистого полёта»: кадры, где квадрик в воздухе, без краша, failsafe и
// битых данных. По умолчанию весь анализ берёт только их; пользователь может
// дополнительно ограничить участок мышью (range).

import cfg from '../config/analysis.json';
import { col } from '../decoder/decoder';
import { LogContext } from './context';

export interface MaskSegment {
  i0: number;
  i1: number; // не включая
}

export interface FlightMask {
  mask: Uint8Array;
  segments: MaskSegment[];
  /** секунд в маске */
  seconds: number;
  /** сколько секунд выкинуто и почему */
  excluded: { ground: number; crash: number; failsafe: number; holes: number; edges: number; range: number };
  crashes: { t: number; g: number }[];
}

export function buildFlightMask(ctx: LogContext, range?: { t0: number; t1: number } | null): FlightMask {
  const { n, fs, tSec, thrPct, motorAvg, log } = ctx;
  const C = cfg.flightMask;
  const mask = new Uint8Array(n);
  const ex = { ground: 0, crash: 0, failsafe: 0, holes: 0, edges: 0, range: 0 };

  // 1) «в воздухе»: газ выше порога или моторы заметно выше холостого
  for (let i = 0; i < n; i++) mask[i] = thrPct[i] >= C.throttleMinPct || motorAvg[i] >= C.motorMinNorm ? 1 : 0;
  // закрываем короткие провалы (флипы и нырки на нулевом газе с airmode — это полёт)
  const gap = Math.round(C.fillGapS * fs);
  let lastOn = -1;
  for (let i = 0; i < n; i++) {
    if (mask[i]) {
      if (lastOn >= 0 && i - lastOn > 1 && i - lastOn <= gap) for (let k = lastOn + 1; k < i; k++) mask[k] = 1;
      lastOn = i;
    }
  }
  let ground = 0;
  for (let i = 0; i < n; i++) if (!mask[i]) ground++;
  ex.ground = ground / fs;

  const clear = (a: number, b: number, key: keyof typeof ex): void => {
    let c = 0;
    for (let i = Math.max(0, a); i < Math.min(n, b); i++) if (mask[i]) { mask[i] = 0; c++; }
    ex[key] += c / fs;
  };

  // 2) удары: |acc| > порога (в g) → вырезаем окно вокруг
  const crashes: { t: number; g: number }[] = [];
  const ax = col(log, 'accSmooth[0]'), ay = col(log, 'accSmooth[1]'), az = col(log, 'accSmooth[2]');
  if (ax && ay && az) {
    const lim2 = (C.crashAccG * ctx.acc1G) ** 2;
    let lastCrash = -1e9;
    for (let i = 0; i < n; i++) {
      const m2 = ax[i] * ax[i] + ay[i] * ay[i] + az[i] * az[i];
      if (m2 > lim2 && tSec[i] - lastCrash > 1) {
        lastCrash = tSec[i];
        crashes.push({ t: tSec[i], g: Math.sqrt(m2) / ctx.acc1G });
        clear(i - Math.round(C.crashBeforeS * fs), i + Math.round(C.crashAfterS * fs), 'crash');
      }
    }
  }

  // 3) failsafe по S-кадрам
  const fsIdx = log.slowFieldNames.indexOf('failsafePhase');
  if (fsIdx >= 0 && log.slow.length) {
    const t0 = log.time[0];
    for (let k = 0; k < log.slow.length; k++) {
      const rec = log.slow[k];
      if (rec.v[fsIdx] === 0) continue;
      const a = (rec.t - t0) / 1e6;
      const b = k + 1 < log.slow.length ? (log.slow[k + 1].t - t0) / 1e6 : tSec[n - 1];
      clear(idxAt(tSec, a), idxAt(tSec, b) + 1, 'failsafe');
    }
  }

  // 4) дыры в данных (битые кадры) ± запас
  if (log.holes.length) {
    const t0 = log.time[0];
    const pad = C.holePadS;
    for (const h of log.holes) {
      const a = h.t0 === null ? 0 : (h.t0 - t0) / 1e6 - pad;
      const b = h.t1 === null ? tSec[n - 1] : (h.t1 - t0) / 1e6 + pad;
      clear(idxAt(tSec, a), idxAt(tSec, b) + 1, 'holes');
    }
  }
  // большой разрыв времени между соседними кадрами (пропущенные кадры) — тоже дыра:
  // БПФ предполагает равномерный шаг, сегмент через разрыв даст ложный спектр
  const gapLim = C.loopGapFactor / fs;
  for (let i = 1; i < n; i++) {
    if (tSec[i] - tSec[i - 1] > gapLim) clear(i - 1, i + 1, 'holes');
  }

  // 5) края каждого участка (взлёт/посадка) и слишком короткие куски
  const segs = runs(mask);
  const edge = Math.round(C.edgeTrimS * fs);
  const minLen = Math.round(C.minSegmentS * fs);
  for (const s of segs) {
    if (s.i1 - s.i0 < minLen + 2 * edge) clear(s.i0, s.i1, 'edges');
    else {
      clear(s.i0, s.i0 + edge, 'edges');
      clear(s.i1 - edge, s.i1, 'edges');
    }
  }

  // 6) участок, выбранный пользователем
  if (range) {
    const a = idxAt(tSec, range.t0), b = idxAt(tSec, range.t1);
    clear(0, a, 'range');
    clear(b + 1, n, 'range');
  }

  const segments = runs(mask);
  // секунды считаем по меткам времени, а не по числу кадров (частота бывает ±1 %)
  let on = 0;
  for (const s of segments) on += tSec[s.i1 - 1] - tSec[s.i0];
  return { mask, segments, seconds: on, excluded: ex, crashes };
}

export function runs(mask: Uint8Array): MaskSegment[] {
  const out: MaskSegment[] = [];
  let s = -1;
  for (let i = 0; i <= mask.length; i++) {
    const v = i < mask.length ? mask[i] : 0;
    if (v && s < 0) s = i;
    else if (!v && s >= 0) {
      out.push({ i0: s, i1: i });
      s = -1;
    }
  }
  return out;
}

/** индекс первого кадра с tSec ≥ t */
export function idxAt(tSec: Float64Array, t: number): number {
  let lo = 0, hi = tSec.length - 1;
  if (hi < 0) return 0;
  if (t <= tSec[0]) return 0;
  if (t >= tSec[hi]) return hi;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (tSec[m] < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}
