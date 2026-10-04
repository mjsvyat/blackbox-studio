// Сравнение двух сессий: честность (сопоставимы ли полёты), разница настроек из заголовков,
// что из плана реально применено (по заголовку следующего лога, а не со слов), метрики с
// дельтой и «лучше/хуже», прогноз и его точность, шум по бинам газа.

import cfg from '../config/analysis.json';
import type { SessionSnapshot } from './snapshot';

const C = cfg.compare;

export type Verdict = 'better' | 'worse' | 'same' | 'na';

export interface Comparability {
  /** совпадение распределений газа, % */
  thrOverlap: number;
  status: 'green' | 'yellow' | 'red';
  /** отношение интенсивности стиков B/A по осям */
  stickRatio: number[];
  cellVDiff: number | null;
  /** ключи предупреждений (тексты — i18n) */
  warnings: ('throttle' | 'sticks' | 'voltage' | 'firmware' | 'craft' | 'log-rate')[];
  bins: { pct: number; aS: number; bS: number; ok: boolean }[];
}

export function comparability(a: SessionSnapshot, b: SessionSnapshot): Comparability {
  let ov = 0;
  for (let i = 0; i < a.flight.thrHist.length; i++) ov += Math.min(a.flight.thrHist[i], b.flight.thrHist[i] ?? 0);
  const stickRatio = a.flight.stickRms.map((v, i) => (v > 0 ? b.flight.stickRms[i] / v : NaN));
  const cellVDiff = a.flight.cellV !== null && b.flight.cellV !== null ? b.flight.cellV - a.flight.cellV : null;
  const warnings: Comparability['warnings'] = [];
  const status: Comparability['status'] = ov >= C.thrOverlap.green ? 'green' : ov >= C.thrOverlap.red ? 'yellow' : 'red';
  if (status !== 'green') warnings.push('throttle');
  if (stickRatio.slice(0, 2).some((r) => Number.isFinite(r) && (r > C.stickRatio || r < 1 / C.stickRatio))) warnings.push('sticks');
  if (cellVDiff !== null && Math.abs(cellVDiff) > C.cellVDiff) warnings.push('voltage');
  if (a.source.firmware !== b.source.firmware) warnings.push('firmware');
  if ((a.source.craft || a.source.board) !== (b.source.craft || b.source.board)) warnings.push('craft');
  if (Math.abs(a.source.fs - b.source.fs) > 1) warnings.push('log-rate');
  const bins = a.noise.thr.pct.map((pct, i) => {
    const aS = a.noise.thr.seconds[i] ?? 0, bS = b.noise.thr.seconds[i] ?? 0;
    return { pct, aS, bS, ok: aS >= C.minBinS && bS >= C.minBinS };
  });
  return { thrOverlap: ov, status: warnings.includes('sticks') && status === 'green' ? 'yellow' : status, stickRatio, cellVDiff, warnings, bins };
}

/** служебные строки заголовка, которые меняются от лога к логу сами по себе */
const VOLATILE = /^(Log start datetime|Product|Data version|I interval|P interval|Field |Firmware date|minthrottle|maxthrottle|motorOutput|vbatref|currentSensor)/;

export function headerDiff(a: Record<string, string>, b: Record<string, string>): { key: string; a: string | undefined; b: string | undefined }[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !VOLATILE.test(k)).sort();
  return keys.filter((k) => a[k] !== b[k]).map((k) => ({ key: k, a: a[k], b: b[k] }));
}

export interface PlanCheck {
  items: { key: string; from: number | undefined; planned: number; actual: number | undefined; state: 'applied' | 'not' | 'other' }[];
  /** изменено вне плана (параметры CLI) */
  extra: { key: string; a: number | undefined; b: number | undefined }[];
  rules: { rule: string; state: 'applied' | 'partial' | 'not' }[];
  state: 'none' | 'applied' | 'partial' | 'not';
}

/** что из плана сессии A реально стоит на борту в сессии B */
export function planCheck(a: SessionSnapshot, b: SessionSnapshot): PlanCheck {
  const plan = a.plan;
  const items: PlanCheck['items'] = [];
  if (plan) {
    for (const [k, v] of Object.entries(plan.to)) {
      const act = b.cli[k];
      items.push({ key: k, from: plan.from[k] ?? a.cli[k], planned: v, actual: act, state: act === v ? 'applied' : act === (plan.from[k] ?? a.cli[k]) ? 'not' : 'other' });
    }
  }
  const extra: PlanCheck['extra'] = [];
  for (const k of new Set([...Object.keys(a.cli), ...Object.keys(b.cli)])) {
    if (plan && k in plan.to) continue;
    if (a.cli[k] !== b.cli[k]) extra.push({ key: k, a: a.cli[k], b: b.cli[k] });
  }
  const rules: PlanCheck['rules'] = [];
  for (const adv of a.advice.filter((x) => x.selected && x.kind === 'tune')) {
    const ks = Object.keys(adv.changes);
    const ok = ks.filter((k) => b.cli[k] === adv.changes[k]).length;
    rules.push({ rule: `${adv.id}@${adv.version}`, state: ok === ks.length ? 'applied' : ok ? 'partial' : 'not' });
  }
  const st = !items.length ? 'none' : items.every((i) => i.state === 'applied') ? 'applied' : items.some((i) => i.state === 'applied') ? 'partial' : 'not';
  return { items, extra, rules, state: st };
}

export interface MetricRow {
  /** ключ подписи (i18n) */
  id: string;
  axis?: number;
  a: number;
  b: number;
  /** прогноз для B (по плану A), если есть */
  pred?: number;
  /** полоса прогноза (модель PID) */
  band?: { lo: number; hi: number };
  verdict: Verdict;
  /** зависит от характера полёта (сравнивать осторожно) */
  flightDependent?: boolean;
  unit: string;
  digits: number;
}

const fin = (x: number | null | undefined): x is number => typeof x === 'number' && Number.isFinite(x);

function verdict(a: number, b: number, low: boolean, absTol = 0): Verdict {
  if (!fin(a) || !fin(b)) return 'na';
  if (Math.abs(b - a) < absTol) return 'same';
  const base = Math.max(Math.abs(a), 1e-9);
  const d = ((b - a) / base) * 100;
  if (Math.abs(d) < C.betterPct) return 'same';
  return (d < 0) === low ? 'better' : 'worse';
}

export function metricRows(a: SessionSnapshot, b: SessionSnapshot): MetricRow[] {
  const rows: MetricRow[] = [];
  // прогноз имеет смысл, только если план действительно стоит на борту в «стало»
  const st = planCheck(a, b).state;
  const pf = st === 'applied' || st === 'partial' ? a.plan?.filters ?? null : null;
  const T = C.absTol;
  const push = (id: string, va: number | null | undefined, vb: number | null | undefined, low: boolean, unit: string, digits: number, axis?: number, pred?: number, flightDependent?: boolean, tol = 0): void => {
    if (!fin(va) && !fin(vb)) return;
    rows.push({ id, axis, a: fin(va) ? va : NaN, b: fin(vb) ? vb : NaN, pred: fin(pred) ? pred : undefined, verdict: verdict(va ?? NaN, vb ?? NaN, low, tol), unit, digits, flightDependent });
  };
  for (let ax = 0; ax < 3; ax++) {
    const na = a.noise.axes[ax], nb = b.noise.axes[ax];
    push('noiseUnfilt', na.rmsUnfilt, nb.rmsUnfilt, true, ' °/с', 1, ax, undefined, true);
    push('noiseFilt', na.rmsFilt, nb.rmsFilt, true, ' °/с', 2, ax, pf ? na.rmsFilt * pf.rmsGyroRatio[ax] : undefined, true);
  }
  for (let ax = 0; ax < 2; ax++) push('dterm', a.noise.axes[ax].rmsDterm, b.noise.axes[ax].rmsDterm, true, '', 1, ax, pf && fin(a.noise.axes[ax].rmsDterm) ? a.noise.axes[ax].rmsDterm! * pf.rmsDtermRatio[ax] : undefined, true);
  if (a.filters && b.filters) {
    push('delay100', a.filters.delay100, b.filters.delay100, true, ' мс', 2, undefined, pf?.delay100);
    push('delayD100', a.filters.delayD100, b.filters.delayD100, true, ' мс', 2, undefined, pf?.delayD100);
  }
  if (a.pid && b.pid) {
    for (let ax = 0; ax < 3; ax++) {
      const pa = a.pid.axes[ax], pb = b.pid.axes[ax];
      if (!pa.enough || !pb.enough) continue;
      // прогноз PID (модель оси) — только при применённом плане
      const pp = st === 'applied' || st === 'partial' ? a.plan?.pid?.find((x) => x.axis === ax) : undefined;
      push('overshoot', pa.overshootPct, pb.overshootPct, true, ' %', 0, ax, pp?.overshoot.mid, false, T.overshoot);
      push('stepDelay', pa.delayMs, pb.delayMs, true, ' мс', 1, ax, pp?.delayMs.mid, false, T.stepDelay);
      // уровень: лучше — ближе к 1
      rows.push({ id: 'settle', axis: ax, a: pa.settle, b: pb.settle, pred: pp?.settle.mid, verdict: Math.abs(pb.settle - pa.settle) < T.settle ? 'same' : verdict(Math.abs(1 - pa.settle), Math.abs(1 - pb.settle), true), unit: '', digits: 2 });
      if (pp) {
        const last = rows.length;
        rows[last - 3].band = pp.overshoot;
        rows[last - 2].band = pp.delayMs;
        rows[last - 1].band = pp.settle;
      }
      push('track', pa.trackRms, pb.trackRms, true, ' °/с', 1, ax, undefined, true);
    }
  }
  return rows;
}

/** точность прогноза: медиана |прогноз − факт| / факт по строкам, где прогноз есть */
export function predictionAccuracy(rows: MetricRow[]): { n: number; medianErrPct: number } {
  const e = rows.filter((r) => r.pred !== undefined && fin(r.b) && Math.abs(r.b) > 1e-9).map((r) => (Math.abs(r.pred! - r.b) / Math.abs(r.b)) * 100).sort((x, y) => x - y);
  return { n: e.length, medianErrPct: e.length ? e[Math.floor(e.length / 2)] : NaN };
}

/** шум после фильтров по бинам газа, только бины с данными в обоих полётах */
export function binNoise(a: SessionSnapshot, b: SessionSnapshot, axis: number): { pct: number; a: number; b: number; verdict: Verdict }[] {
  const cmp = comparability(a, b);
  return cmp.bins.filter((x) => x.ok).map((x) => {
    const i = a.noise.thr.pct.indexOf(x.pct);
    const va = a.noise.thr.filtRms[axis][i], vb = b.noise.thr.filtRms[axis][i];
    return { pct: x.pct, a: va, b: vb, verdict: verdict(va, vb, true) };
  });
}

/** прогноз спектра B: спектр A + изменение модели по плану (дБ) */
export function predictedSpectrum(a: SessionSnapshot, axis: number, kind: 'gyro' | 'dterm'): number[] | null {
  const pf = a.plan?.filters;
  if (!pf) return null;
  const base = kind === 'gyro' ? a.noise.axes[axis].filtDb : a.noise.axes[axis].dtermDb;
  const d = kind === 'gyro' ? pf.gyroDeltaDb[axis] : pf.dtermDeltaDb[axis];
  if (!base || !d) return null;
  // шаги частоты у спектра лога и у модели могут слегка отличаться — берём по частоте
  return base.map((v, i) => {
    const j = Math.round((i * a.noise.df) / pf.df);
    return j < d.length ? v + d[j] : NaN;
  });
}

/**
 * Калибровка полосы прогноза PID по истории борта: на парах «план применён» смотрим, во
 * сколько полуширин полосы промахнулся прогноз перерегулирования. Полоса расширяется так,
 * чтобы ~80 % прошлых фактов в неё попадали (не меньше 1, не больше maxBandScale).
 */
export function pidBandScale(pairs: { a: SessionSnapshot; b: SessionSnapshot }[]): { scale: number; n: number } {
  const z: number[] = [];
  for (const { a, b } of pairs) {
    const st = planCheck(a, b).state;
    if (st !== 'applied' || !a.plan?.pid || !b.pid) continue;
    for (const f of a.plan.pid) {
      const pb = b.pid.axes[f.axis];
      if (!pb?.enough) continue;
      const half = Math.max(cfg.sysid.bandMinPp, (f.overshoot.hi - f.overshoot.lo) / 2);
      z.push(Math.abs(pb.overshootPct - f.overshoot.mid) / half);
    }
  }
  if (!z.length) return { scale: 1, n: 0 };
  z.sort((x, y) => x - y);
  const q = z[Math.min(z.length - 1, Math.floor(0.8 * z.length))];
  return { scale: Math.min(cfg.sysid.maxBandScale, Math.max(1, q)), n: z.length };
}
