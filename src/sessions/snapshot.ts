// Снимок сессии: всё, что нужно для сравнения «было / прогноз / стало» без самого лога
// (лог большой и личный; в сессии — заголовок, метрики, прореженные спектры, step response,
// шум по бинам газа, сработавшие правила и план). Строится в воркере из результатов анализа.

import cfg from '../config/analysis.json';
import type { Advice, AdvisorResult } from '../advisor/advisor';
import type { Card } from '../analysis/summary';
import type { NoiseResult } from '../analysis/noise';
import type { FilterBaseline, FilterEval } from '../filters/evaluate';
import { paramsFromHeader } from '../filters/settings';
import type { PidResult } from '../pid/analyze';
import { gainsFromHeader, gainsToCli, simplifiedFromHeader, simplifiedToCli } from '../pid/gains';
import { profileToCli, ratesFromHeader } from '../rates/rates';

export const SNAPSHOT_VERSION = 1;

export interface SnapshotSource {
  fileName: string;
  logIndex: number;
  datetime: string;
  durationS: number;
  firmware: string;
  fwCode: number;
  board: string;
  craft: string;
  fs: number;
  /** где лог лежит в файле (для папки случая: вырезать байты из того же файла) */
  byteStart?: number;
  byteEnd?: number;
}

export interface SnapAxisNoise {
  rmsUnfilt: number | null;
  rmsFilt: number;
  rmsDterm: number | null;
  unfiltDb: number[] | null;
  filtDb: number[];
  dtermDb: number[] | null;
}

export interface SnapStep {
  enough: boolean;
  activeS: number;
  overshootPct: number;
  delayMs: number;
  settle: number;
  trackRms: number;
  spRms: number;
  t: number[];
  mean: number[];
  std: number[];
}

export interface PlanSnapshot {
  /** изменения выбранных советов (CLI) */
  from: Record<string, number>;
  to: Record<string, number>;
  ruleIds: string[];
  /**
   * точный пересчёт фильтров этого полёта под план (null — план не трогает фильтры).
   * Хранится как изменение относительно модели на текущих настройках: прогноз = лог × это
   * изменение, так погрешность модели против лога сокращается.
   */
  filters: {
    df: number;
    /** новая − текущая модель, дБ, по осям (D-term — ролл/питч) */
    gyroDeltaDb: number[][];
    dtermDeltaDb: number[][];
    /** отношение СКЗ новая / текущая модель */
    rmsGyroRatio: number[];
    rmsDtermRatio: number[];
    delay100: number;
    delayD100: number;
  } | null;
}

export interface SessionSnapshot {
  v: number;
  source: SnapshotSource;
  header: Record<string, string>;
  /** значения всех известных параметров под именами CLI (из заголовка) */
  cli: Record<string, number>;
  flight: {
    seconds: number;
    /** доля времени по бинам газа, % (bins = compare.thrBins) */
    thrHist: number[];
    /** СКЗ setpoint по осям — интенсивность стиков */
    stickRms: number[];
    /** медиана напряжения на банку в полёте, В */
    cellV: number | null;
  };
  cards: { id: string; status: string; phrase: string }[];
  noise: {
    df: number;
    nyquist: number;
    axes: SnapAxisNoise[];
    /** шум по бинам газа: центры бинов, секунды данных, СКЗ после/до фильтров выше bandLowHz по осям */
    thr: { pct: number[]; seconds: number[]; filtRms: number[][]; unfiltRms: number[][] | null };
  };
  filters: { delay100: number; delayD100: number; match: number[]; status: string } | null;
  pid: { axes: SnapStep[] } | null;
  advice: Pick<Advice, 'id' | 'version' | 'kind' | 'severity' | 'selected' | 'deferred' | 'inputs' | 'changes' | 'from'>[];
  plan: PlanSnapshot | null;
}

const r1 = (x: number): number => Math.round(x * 10) / 10;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const arr = (a: ArrayLike<number>, round = r1): number[] => Array.from(a, (v) => (Number.isFinite(v) ? round(v) : NaN));

/** прореживание спектра (дБ) до шага ~targetDf: среднее мощности в группе */
export function decimateDb(db: ArrayLike<number>, df: number, targetDf: number): { db: number[]; df: number } {
  const g = Math.max(1, Math.round(targetDf / df));
  const out: number[] = [];
  for (let i = 0; i + g <= db.length; i += g) {
    let p = 0;
    for (let k = 0; k < g; k++) p += 10 ** (db[i + k] / 10);
    out.push(r1(10 * Math.log10(p / g)));
  }
  return { db: out, df: df * g };
}

function deltaDb(nw: ArrayLike<number>, cur: ArrayLike<number>, df: number): number[] {
  const a = decimateDb(nw, df, cfg.compare.spectrumDf).db, b = decimateDb(cur, df, cfg.compare.spectrumDf).db;
  return a.map((v, i) => r1(v - b[i]));
}

/** все известные параметры под именами CLI из заголовка (фильтры, PID, simplified, рейты) */
export function cliFromHeader(H: Record<string, string>): Record<string, number> {
  const o: Record<string, number> = { ...paramsFromHeader(H), ...gainsToCli(gainsFromHeader(H)) };
  const s = simplifiedFromHeader(H);
  if (s) Object.assign(o, simplifiedToCli(s.s, s.dExtraName));
  const r = ratesFromHeader(H);
  if (r) {
    const rc = profileToCli(r);
    delete rc.quickrates_rc_expo; // в заголовок не пишется
    Object.assign(o, rc);
  }
  for (const k of Object.keys(o)) if (!Number.isFinite(o[k])) delete o[k];
  return o;
}

/** шум по бинам газа из спектрограммы «частота × газ»: укрупняем до bins, СКЗ выше fLow */
function thrNoise(specs: NoiseResult['thrSpec'], fs: number, bins: number, which: 'filt' | 'unfilt'): { pct: number[]; seconds: number[]; rms: number[][] } | null {
  if (which === 'unfilt' && !specs[0].unfilt) return null;
  const s0 = specs[0][which]!;
  const per = Math.max(1, Math.round(s0.rows / bins));
  const segS = (s0.cols - 1) / fs; // сегмент N = 2·(cols−1) кадров с шагом N/2
  const fLow = cfg.noise.bandLowHz;
  const k0 = Math.ceil(fLow / s0.df);
  const pct: number[] = [], seconds: number[] = [];
  const rms: number[][] = specs.map(() => []);
  for (let b = 0; b < bins; b++) {
    let cnt = 0;
    for (let r = b * per; r < Math.min(s0.rows, (b + 1) * per); r++) cnt += s0.counts[r];
    pct.push(((b + 0.5) * 100) / bins);
    seconds.push(r1(cnt * segS));
    specs.forEach((sp, a) => {
      const s = sp[which]!;
      let p = 0, w = 0;
      for (let r = b * per; r < Math.min(s.rows, (b + 1) * per); r++) {
        const c = s.counts[r];
        if (!c || !Number.isFinite(s.data[r * s.cols + k0])) continue;
        let sum = 0;
        for (let k = k0; k < s.cols; k++) sum += 10 ** (s.data[r * s.cols + k] / 10) * s.df;
        p += sum * c;
        w += c;
      }
      rms[a].push(w ? r3(Math.sqrt(p / w)) : NaN);
    });
  }
  return { pct, seconds, rms };
}

export interface SnapshotInput {
  source: SnapshotSource;
  header: Record<string, string>;
  cards: Card[];
  noise: NoiseResult;
  maskSeconds: number;
  thrPct: Float32Array;
  setpoint: (ArrayLike<number> | null)[];
  vbatCell: ArrayLike<number> | null;
  mask: Uint8Array;
  filterBase: FilterBaseline | null;
  pid: PidResult | null;
  advice: AdvisorResult | null;
  /** пересчёт фильтров под план (если план их трогает) */
  planEval: FilterEval | null;
}

export function buildSnapshot(x: SnapshotInput): SessionSnapshot {
  const C = cfg.compare;
  const nz = x.noise;
  const nb = C.thrBins;
  // доля времени по газу и интенсивность стиков — по маске чистого полёта
  const hist = new Array(nb).fill(0) as number[];
  const sp2 = [0, 0, 0];
  let cnt = 0;
  const vs: number[] = [];
  for (let i = 0; i < x.mask.length; i++) {
    if (!x.mask[i]) continue;
    cnt++;
    hist[Math.min(nb - 1, Math.max(0, Math.floor((x.thrPct[i] / 100) * nb)))]++;
    x.setpoint.forEach((s, a) => { if (s) sp2[a] += s[i] * s[i]; });
    if (x.vbatCell && i % 16 === 0 && x.vbatCell[i] > 0) vs.push(x.vbatCell[i]);
  }
  vs.sort((a, b) => a - b);
  const df = nz.axes[0].filt.df;
  const dec = (p: { psd: Float64Array } | null): number[] | null => (p ? decimateDb(Array.from(p.psd, (v) => 10 * Math.log10(Math.max(v, 1e-12))), df, C.spectrumDf).db : null);
  const thrF = thrNoise(nz.thrSpec, nz.fs, nb, 'filt')!;
  const thrU = thrNoise(nz.thrSpec, nz.fs, nb, 'unfilt');
  const fb = x.filterBase;
  const pe = x.planEval;
  const adv = x.advice;
  const ddf = decimateDb([0], df, C.spectrumDf).df;
  return {
    v: SNAPSHOT_VERSION,
    source: x.source,
    header: x.header,
    cli: cliFromHeader(x.header),
    flight: {
      seconds: r1(x.maskSeconds),
      thrHist: hist.map((h) => r1(cnt ? (h / cnt) * 100 : 0)),
      stickRms: sp2.map((s) => r1(cnt ? Math.sqrt(s / cnt) : 0)),
      cellV: vs.length ? r3(vs[Math.floor(vs.length / 2)]) : null,
    },
    cards: x.cards.map((c) => ({ id: c.id, status: c.status, phrase: c.phrase })),
    noise: {
      df: ddf,
      nyquist: nz.nyquist,
      axes: nz.axes.map((a) => ({ rmsUnfilt: a.rmsUnfilt, rmsFilt: r3(a.rmsFilt), rmsDterm: a.rmsDterm === null ? null : r3(a.rmsDterm), unfiltDb: dec(a.unfilt), filtDb: dec(a.filt)!, dtermDb: dec(a.dterm) })),
      thr: { pct: thrF.pct, seconds: thrF.seconds, filtRms: thrF.rms, unfiltRms: thrU ? thrU.rms : null },
    },
    filters: fb ? { delay100: r3(fb.current.delay.gyro['100']), delayD100: r3(fb.current.delay.dterm['100']), match: fb.validation.match.map(r1), status: fb.validation.status } : null,
    pid: x.pid ? {
      axes: x.pid.axes.map((a) => ({
        enough: a.enough, activeS: a.step?.activeS ?? 0,
        overshootPct: r1(a.metrics?.overshootPct ?? NaN), delayMs: r1(a.metrics?.delayMs ?? NaN), settle: r3(a.metrics?.settle ?? NaN),
        trackRms: r1(a.trackRms), spRms: r1(a.spRms),
        t: a.step ? arr(a.step.t, r3) : [], mean: a.step ? arr(a.step.mean, r3) : [], std: a.step ? arr(a.step.std, r3) : [],
      })),
    } : null,
    advice: adv ? adv.advice.map((a) => ({ id: a.id, version: a.version, kind: a.kind, severity: a.severity, selected: a.selected, deferred: a.deferred, inputs: a.inputs, changes: a.changes, from: a.from })) : [],
    plan: adv && Object.keys(adv.to).length ? {
      from: adv.from,
      to: adv.to,
      ruleIds: adv.advice.filter((a) => a.selected && a.kind === 'tune').map((a) => `${a.id}@${a.version}`),
      filters: pe && fb ? {
        df: decimateDb([0], fb.df, C.spectrumDf).df,
        gyroDeltaDb: pe.gyroDb.map((d, a) => deltaDb(d, fb.current.gyroDb[a], fb.df)),
        dtermDeltaDb: pe.dtermDb.map((d, a) => deltaDb(d, fb.current.dtermDb[a], fb.df)),
        rmsGyroRatio: pe.rmsGyro.map((v, a) => r3(v / fb.current.rmsGyro[a])),
        rmsDtermRatio: pe.rmsDterm.map((v, a) => r3(v / fb.current.rmsDterm[a])),
        delay100: r3(pe.delay.gyro['100']), delayD100: r3(pe.delay.dterm['100']),
      } : null,
    } : null,
  };
}
