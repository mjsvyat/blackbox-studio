// Спектральная оценка: Welch PSD по участкам маски, спектрограммы «частота × газ»
// и «частота × время».

import { fft, hann } from './fft';

export interface Psd {
  fs: number;
  n: number;
  df: number;
  /** односторонняя СПМ, (ед.)²/Гц, длина n/2+1 */
  psd: Float64Array;
  segments: number;
}

/** начала сегментов длины n с шагом hop, целиком лежащих внутри маски */
export function segmentStarts(mask: Uint8Array | null, total: number, n: number, hop: number): number[] {
  const out: number[] = [];
  if (!mask) {
    for (let s = 0; s + n <= total; s += hop) out.push(s);
    return out;
  }
  // префиксная сумма маски
  const pre = new Int32Array(total + 1);
  for (let i = 0; i < total; i++) pre[i + 1] = pre[i] + (mask[i] ? 1 : 0);
  let s = 0;
  while (s + n <= total) {
    if (pre[s + n] - pre[s] === n) {
      out.push(s);
      s += hop;
    } else {
      // перепрыгиваем до первого нуля внутри окна + 1
      let z = s + n - 1;
      while (z >= s && mask[z]) z--;
      s = z + 1;
    }
  }
  return out;
}

const scratch = new Map<number, { re: Float64Array; im: Float64Array }>();
function bufs(n: number) {
  let b = scratch.get(n);
  if (!b) {
    b = { re: new Float64Array(n), im: new Float64Array(n) };
    scratch.set(n, b);
  }
  return b;
}

/** СПМ одного сегмента (окно Ханна, вычитание среднего), прибавляется в acc */
export function segmentPsd(x: ArrayLike<number>, start: number, n: number, fs: number, acc: Float64Array, scale = 1): void {
  const { w, sumSq } = hann(n);
  const { re, im } = bufs(n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[start + i];
  mean /= n;
  for (let i = 0; i < n; i++) {
    re[i] = (x[start + i] * scale - mean * scale) * w[i];
    im[i] = 0;
  }
  fft(re, im);
  const k = 1 / (fs * sumSq);
  const half = n / 2;
  for (let i = 0; i <= half; i++) {
    const p = (re[i] * re[i] + im[i] * im[i]) * k * (i === 0 || i === half ? 1 : 2);
    acc[i] += p;
  }
}

export function welch(x: ArrayLike<number>, fs: number, n: number, starts: number[], scale = 1): Psd {
  const psd = new Float64Array(n / 2 + 1);
  for (const s of starts) segmentPsd(x, s, n, fs, psd, scale);
  if (starts.length) for (let i = 0; i < psd.length; i++) psd[i] /= starts.length;
  return { fs, n, df: fs / n, psd, segments: starts.length };
}

/** СКЗ в полосе [f0, f1] по СПМ */
export function bandRms(p: Psd, f0: number, f1: number): number {
  let s = 0;
  const i0 = Math.max(1, Math.ceil(f0 / p.df));
  const i1 = Math.min(p.psd.length - 1, Math.floor(f1 / p.df));
  for (let i = i0; i <= i1; i++) s += p.psd[i] * p.df;
  return Math.sqrt(s);
}

export const toDb = (v: number): number => 10 * Math.log10(Math.max(v, 1e-12));

export interface Peak {
  hz: number;
  db: number;
  /** превышение над локальным «полом» (медиана ±25 Гц), дБ */
  prominenceDb: number;
  /** ширина на уровне −3 дБ, Гц */
  widthHz: number;
}

/** поиск пиков СПМ выше fMin; возвращает по убыванию значимости */
export function findPeaks(p: Psd, fMin: number, fMax: number, maxPeaks = 6, minProminenceDb = 6): Peak[] {
  const db = Array.from(p.psd, toDb);
  // лёгкое сглаживание по 3 бинам, чтобы не ловить шумовые зубцы
  const sm = db.map((_, i) => (db[Math.max(0, i - 1)] + db[i] + db[Math.min(db.length - 1, i + 1)]) / 3);
  const half = Math.max(3, Math.round(25 / p.df));
  // широкий «горб» (резонанс с низкой добротностью) над медианой ±25 Гц не виден —
  // сравниваем ещё с нижним квартилем в окне ±150 Гц
  const wide = Math.max(half * 2, Math.round(150 / p.df));
  const out: Peak[] = [];
  const i0 = Math.max(2, Math.ceil(fMin / p.df));
  const i1 = Math.min(sm.length - 2, Math.floor(fMax / p.df));
  for (let i = i0; i <= i1; i++) {
    if (!(sm[i] > sm[i - 1] && sm[i] >= sm[i + 1])) continue;
    const win: number[] = [];
    for (let k = Math.max(1, i - half); k <= Math.min(sm.length - 1, i + half); k++) win.push(sm[k]);
    win.sort((a, b) => a - b);
    const floor = win[Math.floor(win.length / 2)];
    const wwin: number[] = [];
    for (let k = Math.max(1, i - wide); k <= Math.min(sm.length - 1, i + wide); k += 2) wwin.push(sm[k]);
    wwin.sort((a, b) => a - b);
    const wfloor = wwin[Math.floor(wwin.length / 4)];
    const prom = Math.max(sm[i] - floor, sm[i] - wfloor);
    if (prom < minProminenceDb) continue;
    let l = i, r = i;
    while (l > 1 && sm[l] > sm[i] - 3) l--;
    while (r < sm.length - 1 && sm[r] > sm[i] - 3) r++;
    out.push({ hz: i * p.df, db: sm[i], prominenceDb: prom, widthHz: (r - l) * p.df });
  }
  out.sort((a, b) => b.prominenceDb + b.db * 0.5 - (a.prominenceDb + a.db * 0.5));
  // убрать близкие дубли (в пределах ширины более сильного пика)
  const kept: Peak[] = [];
  for (const pk of out) {
    if (kept.some((k) => Math.abs(k.hz - pk.hz) < Math.max(8, k.widthHz / 2))) continue;
    kept.push(pk);
    if (kept.length >= maxPeaks) break;
  }
  return kept;
}

export interface Spectrogram {
  /** строки (бины газа или моменты времени) × частотные бины, дБ; NaN — нет данных */
  rows: number;
  cols: number;
  df: number;
  data: Float32Array;
  /** число сегментов в каждой строке */
  counts: Int32Array;
  /** средняя частота вращения моторов в строке, Гц (NaN — нет eRPM) */
  motorHz: Float32Array;
  /** подписи строк: % газа (центр бина) или время, с */
  rowValue: Float32Array;
}

/**
 * Спектрограмма «частота × газ»: сегменты из маски, раскладываем по бинам газа.
 * thr — газ 0..100 % на каждый кадр, motorHz — средняя частота моторов на кадр (или null).
 */
export function throttleSpectrogram(
  x: ArrayLike<number>, thr: Float32Array, motorHz: Float32Array | null, fs: number, n: number,
  starts: number[], bins = 20, scale = 1, minCount = 3,
): Spectrogram {
  const cols = n / 2 + 1;
  const acc = new Float64Array(bins * cols);
  const counts = new Int32Array(bins);
  const mh = new Float64Array(bins);
  const mhN = new Int32Array(bins);
  const tmp = new Float64Array(cols);
  for (const s of starts) {
    let th = 0, m = 0, mN = 0;
    for (let i = s; i < s + n; i++) {
      th += thr[i];
      if (motorHz && motorHz[i] > 0) { m += motorHz[i]; mN++; }
    }
    th /= n;
    const b = Math.min(bins - 1, Math.max(0, Math.floor((th / 100) * bins)));
    tmp.fill(0);
    segmentPsd(x, s, n, fs, tmp, scale);
    for (let k = 0; k < cols; k++) acc[b * cols + k] += tmp[k];
    counts[b]++;
    if (mN) { mh[b] += m / mN; mhN[b]++; }
  }
  const data = new Float32Array(bins * cols);
  for (let b = 0; b < bins; b++) {
    // строку из 1–2 сегментов не показываем: одна четверть секунды (часто удар) — не статистика
    for (let k = 0; k < cols; k++) data[b * cols + k] = counts[b] >= minCount ? toDb(acc[b * cols + k] / counts[b]) : NaN;
  }
  const motor = new Float32Array(bins);
  const rowValue = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    motor[b] = mhN[b] ? mh[b] / mhN[b] : NaN;
    rowValue[b] = ((b + 0.5) * 100) / bins;
  }
  return { rows: bins, cols, df: fs / n, data, counts, motorHz: motor, rowValue };
}

/** Спектрограмма «частота × время» по всему логу; не больше maxRows столбцов времени */
export function timeSpectrogram(
  x: ArrayLike<number>, time: Float64Array, motorHz: Float32Array | null, fs: number, n: number,
  total: number, maxRows = 1200, scale = 1,
): Spectrogram {
  const cols = n / 2 + 1;
  const possible = Math.max(1, Math.floor((total - n) / (n / 2)) + 1);
  const hop = possible > maxRows ? Math.ceil((total - n) / (maxRows - 1)) : n / 2;
  const starts: number[] = [];
  for (let s = 0; s + n <= total; s += hop) starts.push(s);
  const rows = starts.length;
  const data = new Float32Array(rows * cols);
  const motor = new Float32Array(rows);
  const rowValue = new Float32Array(rows);
  const counts = new Int32Array(rows).fill(1);
  const tmp = new Float64Array(cols);
  const t0 = time[0];
  starts.forEach((s, r) => {
    tmp.fill(0);
    segmentPsd(x, s, n, fs, tmp, scale);
    for (let k = 0; k < cols; k++) data[r * cols + k] = toDb(tmp[k]);
    let m = 0, mN = 0;
    if (motorHz) for (let i = s; i < s + n; i += 4) if (motorHz[i] > 0) { m += motorHz[i]; mN++; }
    motor[r] = mN ? m / mN : NaN;
    rowValue[r] = (time[s + n / 2] - t0) / 1e6;
  });
  return { rows, cols, df: fs / n, data, counts, motorHz: motor, rowValue };
}
