// Синхронизация видео с логом. Сдвиг o: время в видео = время в логе + o.
//  - грубо: по часам — «Log start datetime» полётника и время создания MOV. Часы очков и
//    полётника разные (часовой пояс, неточная установка): перебираются сдвиги на целые часы,
//    выбирается тот, при котором лог больше всего перекрывается с видео;
//  - точно: камера FPV жёстко на раме, поэтому «рывки кадра» (разница соседних кадров) идут
//    вместе с угловой скоростью из лога. Нормированная взаимная корреляция двух рядов на общей
//    сетке ищет сдвиг в окне вокруг грубой оценки.
// Чистые функции; кадры видео считает интерфейс (canvas), угловую скорость — воркер.

export interface CoarseSync {
  /** сдвиг, с (null — часов нет или ни один вариант не перекрывается) */
  offsetS: number | null;
  /** на сколько целых часов поправлены часы (часовой пояс) */
  tzHours: number;
  /** доля лога, попадающая в видео при этом сдвиге */
  overlap: number;
}

/** время начала лога из заголовка, мс; null — часы полётника не установлены */
export function logStartMs(datetime: string): number | null {
  if (!datetime || /^0000|^1970/.test(datetime)) return null;
  const t = Date.parse(datetime);
  return Number.isFinite(t) ? t : null;
}

export function coarseOffset(logStart: number | null, logDurS: number, videoStart: number | null, videoDurS: number): CoarseSync {
  if (logStart === null || videoStart === null) return { offsetS: null, tzHours: 0, overlap: 0 };
  const raw = (logStart - videoStart) / 1000;
  let best: CoarseSync = { offsetS: null, tzHours: 0, overlap: 0 };
  for (let k = -14; k <= 14; k++) {
    const o = raw + k * 3600;
    const ov = Math.max(0, Math.min(o + logDurS, videoDurS) - Math.max(o, 0)) / Math.max(1e-9, Math.min(logDurS, videoDurS));
    if (ov > best.overlap + 1e-9 || (Math.abs(ov - best.overlap) < 1e-9 && ov > 0 && Math.abs(k) < Math.abs(best.tzHours))) best = { offsetS: o, tzHours: k, overlap: ov };
  }
  return best.overlap > 0 ? best : { offsetS: null, tzHours: 0, overlap: 0 };
}

/** ряд на равномерной сетке: значения в моменты t0 + i/hz (линейная интерполяция, вне — NaN) */
export function resample(t: ArrayLike<number>, v: ArrayLike<number>, t0: number, hz: number, n: number): Float64Array {
  const out = new Float64Array(n).fill(NaN);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const x = t0 + i / hz;
    while (j < t.length - 2 && t[j + 1] < x) j++;
    if (x < t[0] || x > t[t.length - 1]) continue;
    const dt = t[j + 1] - t[j];
    const a = dt > 0 ? (x - t[j]) / dt : 0;
    out[i] = v[j] + (v[j + 1] - v[j]) * Math.min(1, Math.max(0, a));
  }
  return out;
}

export interface FineSync {
  offsetS: number;
  /** корреляция в лучшей точке (0…1) */
  score: number;
  /** лучшая / вторая по величине вершина вдали от лучшей (> 1.3 — уверенно) */
  margin: number;
}

/**
 * Сдвиг по корреляции: лог (t, |ω|) и видео (t, движение кадра), сдвиг ищется в
 * [center − range, center + range] с шагом 1/hz. Ряды переводятся в логарифм и нормируются —
 * важна форма «всплесков», а не масштаб.
 */
export function fineOffset(logT: ArrayLike<number>, logV: ArrayLike<number>, vidT: ArrayLike<number>, vidV: ArrayLike<number>, center: number, range: number, hz = 30): FineSync | null {
  if (logT.length < 4 || vidT.length < 4) return null;
  const v0 = vidT[0], v1 = vidT[vidT.length - 1];
  const n = Math.floor((v1 - v0) * hz);
  const lags = Math.round(range * hz);
  const vid = resample(vidT, Array.from(vidV, (x) => Math.log1p(Math.max(0, x))), v0, hz, n);
  // лог один раз на сетке: L[j] — момент v0 − center − range + j/hz; сдвиг k → срез с j = i − k + lags
  const L = resample(logT, Array.from(logV, (x) => Math.log1p(Math.max(0, x))), v0 - center - range, hz, n + 2 * lags + 1);
  const scores: number[] = [];
  let bi = -1, bs = -Infinity;
  for (let k = -lags; k <= lags; k++) {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, c = 0;
    for (let i = 0; i < n; i++) {
      const x = L[i - k + lags], y = vid[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; c++;
    }
    let sc = -Infinity;
    if (c > hz * 3) {
      const cov = sxy / c - (sx / c) * (sy / c);
      const den = Math.sqrt(Math.max(1e-12, (sxx / c - (sx / c) ** 2) * (syy / c - (sy / c) ** 2)));
      sc = cov / den;
    }
    scores.push(sc);
    if (sc > bs) { bs = sc; bi = k + lags; }
  }
  if (bi < 0 || !Number.isFinite(bs)) return null;
  // вторая вершина — дальше 0.5 с от лучшей
  let second = 0;
  scores.forEach((s, i) => { if (Math.abs(i - bi) > hz / 2 && s > second) second = s; });
  // уточнение параболой по трём точкам
  let frac = 0;
  if (bi > 0 && bi < scores.length - 1 && Number.isFinite(scores[bi - 1]) && Number.isFinite(scores[bi + 1])) {
    const a = scores[bi - 1], b = scores[bi], c = scores[bi + 1];
    const den = a - 2 * b + c;
    if (den < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
  }
  return { offsetS: center + (bi - lags + frac) / hz, score: Math.max(0, bs), margin: second > 0 ? bs / second : Infinity };
}

/** модуль угловой скорости, °/с */
export function rateMagnitude(g: (ArrayLike<number> | null)[], n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const a of g) if (a) s += a[i] * a[i];
    out[i] = Math.sqrt(s);
  }
  return out;
}

/** движение кадра: средняя абсолютная разница яркости двух кадров (маленьких, серых) */
export function frameDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) {
    const ya = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    const yb = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
    s += Math.abs(ya - yb);
    n++;
  }
  return n ? s / n : 0;
}
