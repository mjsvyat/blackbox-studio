/// <reference lib="webworker" />
// Web Worker: декодирование, анализ, выдача рядов для графиков. Весь лог живёт
// здесь; в UI уходят только спектры, метрики и прореженные куски рядов.

import { freqView } from '../sysid/chirp';
import { activeClass, classInfo, setBoardClass } from '../config/classes';
import { rateMagnitude } from '../video/sync';
import { LogContext, buildContext } from '../analysis/context';
import { idxAt } from '../analysis/flightMask';
import { byThrottle } from '../analysis/health';
import { Analysis, adviseLog, analyzeLog, pidForecastCurves, snapshotLog } from '../analysis/pipeline';
import { SAME } from '../sysid/axisModel';
import { forecastAxis } from '../sysid/predict';
import { Column, col, decodeLog } from '../decoder/decoder';
import { FileStructure, blobReader, scanFile } from '../decoder/scan';
import { toDb } from '../dsp/spectrum';
import { T } from '../i18n/ru';
import type { AdvicePayload, AnalysisPayload, FiltersPayload, FromWorker, LogInfo, PidPayload, RatesPayload, ToWorker } from './protocol';
import { simplifiedFromHeader } from '../pid/gains';
import type { AdvisorResult, BoardKnowledge } from '../advisor/advisor';
import type { SessionSnapshot } from '../sessions/snapshot';
import { FilterBaseline, evaluate, quantFloorPsd } from '../filters/evaluate';
import { FilterContext, simplifiedConsistent } from '../filters/settings';
import { RatesWork, buildRatesBase, evalRates, newSetpoint } from '../rates/analyze';
import { ratesFromHeader } from '../rates/rates';

const ctxW = self as unknown as DedicatedWorkerGlobalScope;

let file: Blob | null = null;
let structure: FileStructure | null = null;
let ctx: LogContext | null = null;
let crossesWrap = false;
let range: { t0: number; t1: number } | null = null;
let series: Map<string, ArrayLike<number>> = new Map();
// результат анализа на текущей маске (pipeline.ts) и производные для вкладок
let cur: Analysis | null = null;
let lastMask: Uint8Array | null = null;
let lastNoiseStatus = 'grey';
let filterBase: FilterBaseline | null = null;
let filtersPayload: FiltersPayload | null = null;
let filterCtx: FilterContext | null = null;
// для рейтов: база на текущей маске (сбрасывается при смене участка)
let ratesWork: RatesWork | null = null;
let lastAdvice: AdvisorResult | null = null;
let fileName = '';
let logIndex = -1;

const post = (m: FromWorker, transfer: Transferable[] = []): void => ctxW.postMessage(m, transfer);
const progress = (stage: string, fraction: number): void => post({ type: 'progress', stage, fraction });

ctxW.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type === 'scan') {
      file = m.file;
      ctx = null;
      fileName = m.name;
      structure = await scanFile(blobReader(m.file), (f, stage) => progress(`${T.scanning}: ${stage}`, f));
      post({ type: 'scanned', structure, name: m.name });
    } else if (m.type === 'open') {
      await openLog(m.logIndex);
    } else if (m.type === 'setClass') {
      // класс борта: пороги с переопределениями; открытый лог — пересчитать светофор и советы
      setBoardClass(m.cls);
      if (ctx) post({ type: 'analysis', analysis: analyze() });
    } else if (m.type === 'setRange') {
      range = m.range;
      if (ctx) post({ type: 'analysis', analysis: analyze() });
    } else if (m.type === 'filtersInit') {
      if (ctx) {
        if (!filtersPayload) filtersPayload = computeFilters(ctx);
        post({ type: 'filters', payload: filtersPayload });
      }
    } else if (m.type === 'filtersEval') {
      if (ctx && filterBase && filterCtx) {
        const { ev } = evaluate(ctx, m.params, filterCtx, filterBase.segments, filterBase.n, filterBase.current.op);
        post({ type: 'filtersEval', reqId: m.reqId, ev });
      }
    } else if (m.type === 'ratesInit') {
      if (ctx) {
        const r = computeRates(ctx);
        post({ type: 'rates', payload: r.payload, why: r.why });
      }
    } else if (m.type === 'ratesEval') {
      if (ctx && ratesWork) {
        const sp = newSetpoint(ctx, ratesWork, m.profile);
        sp.forEach((a, i) => series.set(`spN${i}`, a));
        post({ type: 'ratesEval', reqId: m.reqId, ev: evalRates(ctx, ratesWork, sp) });
      }
    } else if (m.type === 'pidInit') {
      if (ctx && cur?.pid) post({ type: 'pid', payload: pidPayload(ctx) });
    } else if (m.type === 'pidPredict') {
      if (ctx && cur) post({ type: 'pidPredict', reqId: m.reqId, axes: pidForecastCurves(cur, m.changes, m.bandScale) });
    } else if (m.type === 'adviceInit') {
      if (ctx) post({ type: 'advice', payload: computeAdvice(ctx, m.board) });
    } else if (m.type === 'snapshot') {
      if (ctx) post({ type: 'snapshot', reqId: m.reqId, snap: snapshot(ctx, m.board) });
    } else if (m.type === 'series') {
      const r = getSeries(m.keys, m.t0, m.t1, m.width);
      post({ type: 'series', reqId: m.reqId, ...r }, [r.x.buffer, ...r.ys.map((y) => y.buffer)]);
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? `${err.message}` : String(err) });
  }
};

async function openLog(index: number): Promise<void> {
  if (!file || !structure) throw new Error('Файл не загружен');
  const L = structure.logs.find((l) => l.index === index);
  if (!L) throw new Error(`Нет лога №${index}`);
  crossesWrap = L.crossesWrap;
  logIndex = index;
  const end = L.crossesWrap && L.wrapBoundary ? L.wrapBoundary : L.end;
  progress(T.loading, 0);
  const buf = new Uint8Array(await file.slice(L.start, end).arrayBuffer());
  ctx = null;
  series = new Map();
  const log = decodeLog(buf, 0, buf.length, { onProgress: (f) => progress(T.decoding, f * 0.8) });
  if (log.n < 10) throw new Error('В логе почти нет кадров — нечего анализировать.');
  progress(T.analyzing, 0.85);
  ctx = buildContext(log);
  range = null;
  buildSeries(ctx);
  const analysis = analyze();
  const t0 = log.time[0];
  const info: LogInfo = {
    index,
    durationS: ctx.tSec[ctx.n - 1],
    frames: ctx.n,
    fs: ctx.fs,
    nyquist: ctx.fs / 2,
    firmware: ctx.fw.raw,
    board: log.header['Board information'] || '',
    craft: log.header['Craft name'] || '',
    datetime: log.header['Log start datetime'] || '',
    hasGyroUnfilt: ctx.hasGyroUnfilt,
    hasErpm: ctx.hasErpm,
    motorCount: ctx.motorCount,
    cells: ctx.cells,
    header: log.header,
    events: log.events.map((ev) => ({
      t: Math.max(0, (ev.t - t0) / 1e6),
      name: ev.name,
      detail: ev.reason ?? (ev.on?.length || ev.off?.length ? `${ev.on?.length ? '+' + ev.on.join(' +') : ''} ${ev.off?.length ? '−' + ev.off.join(' −') : ''}`.trim() : ''),
    })),
    modes: lastHealthModes,
    holes: log.holes.map((h) => [h.t0 === null ? null : (h.t0 - t0) / 1e6, h.t1 === null ? null : (h.t1 - t0) / 1e6]),
    warnings: ctx.warnings,
    truncatedAtWrap: L.crossesWrap && L.wrapBoundary ? L.end - L.wrapBoundary : null,
  };
  progress('', 1);
  post({ type: 'opened', info, analysis });
}

let lastHealthModes: LogInfo['modes'] = [];

function analyze(): AnalysisPayload {
  const c = ctx!;
  const A = analyzeLog(c, range, { crossesWrap }, (what, err) => console.error(what, err));
  cur = A;
  const { fm, nz, h, cards } = A;
  lastHealthModes = h.modes;
  // маска как ряд для графика
  const maskSeries = new Float32Array(c.n);
  for (let i = 0; i < c.n; i++) maskSeries[i] = fm.mask[i] ? 100 : 0;
  series.set('mask', maskSeries);
  lastMask = fm.mask;
  ratesWork = null;
  lastAdvice = null;
  filtersPayload = null;
  try {
    filtersPayload = computeFilters(c);
  } catch (err) {
    console.error('filters', err);
  }
  lastNoiseStatus = cards.find((x) => x.id === 'noise')?.status ?? 'grey';
  if (filtersPayload) filtersPayload.noiseStatus = lastNoiseStatus;
  const dbArr = (p: { psd: Float64Array } | null): Float32Array | null => (p ? Float32Array.from(p.psd, toDb) : null);
  for (const b of nz.bursts) {
    h.anomalies.push({ kind: 'BURST', t0: b.t0, t1: b.t1, value: b.ratio, text: `Всплеск тряски (в ${b.ratio.toFixed(0)} раз сильнее обычного) — исключён из спектров` });
  }
  h.anomalies.sort((a, b) => a.t0 - b.t0);
  return {
    cls: classInfo(activeClass()),
    cards,
    logCheck: A.logCheck,
    maskSegments: fm.segments.map((s) => [c.tSec[s.i0], c.tSec[s.i1 - 1]] as [number, number]),
    maskSeconds: fm.seconds,
    excluded: fm.excluded,
    range,
    noise: {
      df: nz.axes[0].filt.df,
      fs: nz.fs,
      nyquist: nz.nyquist,
      segments: nz.segments,
      motorHzMedian: nz.motorHzMedian,
      axes: nz.axes.map((a) => ({
        axis: a.axis,
        unfilt: dbArr(a.unfilt),
        filt: dbArr(a.filt)!,
        dterm: dbArr(a.dterm),
        rmsUnfilt: a.rmsUnfilt,
        rmsFilt: a.rmsFilt,
        reductionDb: a.reductionDb,
        rmsDterm: a.rmsDterm,
        rmsMid: a.rmsMid,
        peaks: a.peaks,
      })),
      thrSpec: nz.thrSpec,
      timeSpec: nz.timeSpec,
      bursts: nz.bursts,
      degraded: nz.degraded,
    },
    anomalies: h.anomalies,
    health: { motors: h.motors, power: h.power, link: h.link, thr: byThrottle(c, fm) },
  };
}

function computeFilters(c: LogContext): FiltersPayload {
  const f = cur!.filters;
  if (!f) throw new Error('модель фильтров не построена');
  const { params, base, sim } = f;
  filterCtx = f.fctx;
  filterBase = base;
  // дорожки: каждые ~50 мс
  const step = Math.max(1, Math.round(c.fs * 0.05));
  const idx: number[] = [];
  for (let i = 0; i < c.n; i += step) if (sim.covered[i]) idx.push(i);
  const t = Float32Array.from(idx, (i) => c.tSec[i]);
  const dyn = sim.dynHz.map((ax) => ax.map((arr) => Float32Array.from(idx, (i) => arr[i])));
  const lpf1 = Float32Array.from(idx, (i) => sim.lpf1Hz[i]);
  return {
    base, params, fwCode: c.fw.code, simplified: simplifiedConsistent(params),
    track: { t, dyn, lpf1 }, quantFloorDb: toDb(quantFloorPsd(c.fs)), noiseStatus: lastNoiseStatus,
  };
}

function computeRates(c: LogContext): { payload: RatesPayload | null; why?: string } {
  const profile = ratesFromHeader(c.log.header);
  if (!profile) return { payload: null, why: 'no-header' };
  if (!ratesWork) ratesWork = buildRatesBase(c, lastMask!, profile);
  // «новый» setpoint до первого пересчёта примерки = записанный
  for (let a = 0; a < 3; a++) if (!series.has(`spN${a}`) && series.has(`sp${a}`)) series.set(`spN${a}`, series.get(`sp${a}`)!);
  return { payload: { ...ratesWork.base, fwCode: c.fw.code } };
}

function pidPayload(c: LogContext): PidPayload {
  const sy = cur!.sysid;
  const model = sy ? {
    t: sy.t,
    axes: sy.axes.map((m) => ({
      ...forecastAxis(m, SAME, sy.t),
      tauMs: m.plant.a > 0 ? (-1000 / m.fs) / Math.log(m.plant.a) : NaN,
      plantDelayMs: (m.plant.d / m.fs) * 1000,
      pFit: m.ctrl.pFit, dFit: m.ctrl.dFit, fFit: m.ctrl.fFit,
      source: m.source ?? ('step' as const),
    })),
  } : null;
  const freq = cur!.chirp ? freqView(cur!.chirp, c.tSec) : null;
  return { ...cur!.pid!, fwCode: c.fw.code, simplified: simplifiedFromHeader(c.log.header), model, freq };
}

let lastBoardKey = '';
function computeAdvice(c: LogContext, board?: BoardKnowledge): AdvicePayload {
  const key = JSON.stringify(board ?? null);
  if (!lastAdvice || key !== lastBoardKey) {
    lastAdvice = adviseLog(cur!, (what, err) => console.error(what, err), board);
    lastBoardKey = key;
  }
  return { ...lastAdvice, fwCode: c.fw.code };
}

function snapshot(c: LogContext, board?: BoardKnowledge): SessionSnapshot {
  computeAdvice(c, board);
  const L = structure?.logs.find((l) => l.index === logIndex);
  const byteEnd = L ? (L.crossesWrap && L.wrapBoundary ? L.wrapBoundary : L.end) : undefined;
  return snapshotLog(cur!, lastAdvice!, { fileName, logIndex, byteStart: L?.start, byteEnd }, (what, err) => console.error(what, err), board?.pidBandScale ?? 1);
}

/** производные ряды в физических единицах */
function buildSeries(c: LogContext): void {
  const s = series;
  const log = c.log;
  const put = (key: string, column: Column | null, scale = 1): void => {
    if (!column) return;
    if (scale === 1) s.set(key, column);
    else {
      const a = new Float32Array(c.n);
      for (let i = 0; i < c.n; i++) a[i] = column[i] * scale;
      s.set(key, a);
    }
  };
  for (let a = 0; a < 3; a++) {
    put(`gyro${a}`, col(log, `gyroADC[${a}]`));
    put(`gyroU${a}`, col(log, `gyroUnfilt[${a}]`));
    put(`sp${a}`, col(log, `setpoint[${a}]`));
    put(`P${a}`, col(log, `axisP[${a}]`));
    put(`I${a}`, col(log, `axisI[${a}]`));
    put(`D${a}`, col(log, `axisD[${a}]`));
    put(`F${a}`, col(log, `axisF[${a}]`));
  }
  s.set('thr', c.thrPct);
  // модуль угловой скорости — для синхронизации с видео (движение кадра) и оверлея
  s.set('rate', rateMagnitude([0, 1, 2].map((a) => col(log, `gyroADC[${a}]`)), c.n));
  c.motorNorm.forEach((m, i) => {
    const a = new Float32Array(c.n);
    for (let k = 0; k < c.n; k++) a[k] = m[k] * 100;
    s.set(`m${i}`, a);
  });
  c.motorHzEach?.forEach((m, i) => s.set(`mhz${i}`, m));
  put('vbat', col(log, 'vbatLatest'), 0.01);
  put('amp', col(log, 'amperageLatest'), 0.01);
  const rssi = col(log, 'rssi');
  if (rssi) put('rssi', rssi, 1 / 10.23);
}

/** min/max-прореживание под ширину графика; при малом числе точек — сырые данные */
function getSeries(keys: string[], t0: number, t1: number, width: number): { x: Float64Array; ys: Float32Array[]; raw: boolean } {
  const c = ctx;
  if (!c) return { x: new Float64Array(0), ys: keys.map(() => new Float32Array(0)), raw: true };
  const i0 = Math.max(0, idxAt(c.tSec, t0) - 1);
  const i1 = Math.min(c.n - 1, idxAt(c.tSec, t1) + 1);
  const count = i1 - i0 + 1;
  const cols = keys.map((k) => series.get(k) ?? null);
  const bins = Math.max(10, Math.floor(width));
  if (count <= bins * 2) {
    const x = c.tSec.slice(i0, i1 + 1);
    const ys = cols.map((a) => {
      const y = new Float32Array(count);
      if (a) for (let i = 0; i < count; i++) y[i] = a[i0 + i];
      else y.fill(NaN);
      return y;
    });
    return { x, ys, raw: true };
  }
  const x = new Float64Array(bins * 2);
  const ys = cols.map(() => new Float32Array(bins * 2));
  const per = count / bins;
  for (let b = 0; b < bins; b++) {
    const a0 = i0 + Math.floor(b * per);
    const a1 = Math.min(i1 + 1, i0 + Math.floor((b + 1) * per));
    x[2 * b] = c.tSec[a0];
    x[2 * b + 1] = c.tSec[Math.max(a0, Math.floor((a0 + a1 - 1) / 2))];
    cols.forEach((arr, k) => {
      if (!arr) {
        ys[k][2 * b] = ys[k][2 * b + 1] = NaN;
        return;
      }
      let mn = Infinity, mx = -Infinity, imn = a0, imx = a0;
      for (let i = a0; i < a1; i++) {
        const v = arr[i];
        if (v < mn) { mn = v; imn = i; }
        if (v > mx) { mx = v; imx = i; }
      }
      // порядок min/max как во времени — линия рисуется без ложных перехлёстов
      if (imn <= imx) { ys[k][2 * b] = mn; ys[k][2 * b + 1] = mx; }
      else { ys[k][2 * b] = mx; ys[k][2 * b + 1] = mn; }
    });
  }
  return { x, ys, raw: false };
}
