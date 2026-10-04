// Состояние приложения и связь с воркером.

import type { FileStructure } from '../decoder/scan';
import type { AnalysisPayload, FiltersPayload, FromWorker, LogInfo, RatesPayload, ToWorker } from '../worker/protocol';
import type { FilterEval } from '../filters/evaluate';
import type { FilterParams } from '../filters/settings';
import type { RatesEval } from '../rates/analyze';
import type { RateProfile } from '../rates/rates';
import WorkerCtor from '../worker/worker.ts?worker&inline';

export interface AppState {
  fileName: string | null;
  structure: FileStructure | null;
  info: LogInfo | null;
  analysis: AnalysisPayload | null;
  /** видимый диапазон времени на графиках, с */
  view: { t0: number; t1: number } | null;
  tab: string;
  noiseAxis: number;
  noiseSource: 'unfilt' | 'filt';
  progress: { stage: string; fraction: number } | null;
  error: string | null;
  filters: FiltersPayload | null;
  /** настройки в песочнице */
  sandbox: FilterParams | null;
  sandboxEval: FilterEval | null;
  sandboxBusy: boolean;
  filterAxis: number;
  /** рейты: база из воркера; null + ratesWhy — посчитать нельзя */
  rates: RatesPayload | null;
  ratesWhy: string | null;
  ratesSandbox: RateProfile | null;
  ratesEval: RatesEval | null;
  ratesBusy: boolean;
  /** выбранный манёвр (индекс в rates.maneuvers) */
  ratesManeuver: number;
}

type Listener = (s: AppState, changed: Set<keyof AppState>) => void;

export const state: AppState = {
  fileName: null,
  structure: null,
  info: null,
  analysis: null,
  view: null,
  tab: 'file',
  noiseAxis: 0,
  noiseSource: 'unfilt',
  progress: null,
  error: null,
  filters: null,
  sandbox: null,
  sandboxEval: null,
  sandboxBusy: false,
  filterAxis: 0,
  rates: null,
  ratesWhy: null,
  ratesSandbox: null,
  ratesEval: null,
  ratesBusy: false,
  ratesManeuver: 0,
};

const listeners = new Set<Listener>();
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function set(patch: Partial<AppState>): void {
  const changed = new Set<keyof AppState>();
  for (const [k, v] of Object.entries(patch) as [keyof AppState, unknown][]) {
    if (state[k] !== v) {
      (state as unknown as Record<string, unknown>)[k] = v;
      changed.add(k);
    }
  }
  if (changed.size) for (const l of [...listeners]) l(state, changed);
}

// --- воркер ---
const worker: Worker = new WorkerCtor();
let reqSeq = 0;
const pending = new Map<number, (r: { x: Float64Array; ys: Float32Array[]; raw: boolean }) => void>();

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'progress':
      set({ progress: m.fraction >= 1 && !m.stage ? null : { stage: m.stage, fraction: m.fraction } });
      break;
    case 'scanned': {
      set({ structure: m.structure, fileName: m.name, info: null, analysis: null, view: null, progress: null, tab: 'file', error: null });
      // единственный нормальный лог — открываем сразу
      const usable = m.structure.logs.filter((l) => l.duplicateOf === null && l.headerOk && !l.empty);
      if (usable.length === 1) openLog(usable[0].index);
      break;
    }
    case 'opened':
      set({ filters: null, sandbox: null, sandboxEval: null, rates: null, ratesWhy: null, ratesSandbox: null, ratesEval: null, ratesManeuver: 0, info: m.info, analysis: m.analysis, view: { t0: 0, t1: m.info.durationS }, progress: null, error: null, tab: state.tab === 'file' ? 'summary' : state.tab });
      break;
    case 'analysis':
      set({ analysis: m.analysis, progress: null, filters: null, sandboxEval: null, rates: null, ratesEval: null, ratesManeuver: 0 });
      break;
    case 'filters':
      if (state.sandbox) {
        // участок анализа поменялся — песочницу пересчитать на новых данных
        set({ filters: m.payload, progress: null });
        requestSandbox(state.sandbox);
      } else set({ filters: m.payload, sandbox: { ...m.payload.params }, sandboxEval: m.payload.base.current, progress: null });
      break;
    case 'filtersEval':
      if (m.reqId === sandboxReq) set({ sandboxEval: m.ev, sandboxBusy: false });
      break;
    case 'rates':
      set({ rates: m.payload, ratesWhy: m.payload ? null : m.why ?? 'unknown', progress: null });
      // участок анализа поменялся, а в песочнице уже что-то есть — пересчитать
      if (m.payload) requestRatesEval(state.ratesSandbox ?? m.payload.profile, 0);
      break;
    case 'ratesEval':
      if (m.reqId === ratesReq) set({ ratesEval: m.ev, ratesBusy: false });
      break;
    case 'series': {
      const cb = pending.get(m.reqId);
      pending.delete(m.reqId);
      cb?.(m);
      break;
    }
    case 'error':
      set({ error: m.message, progress: null });
      break;
  }
};

worker.onerror = (e) => {
  set({ error: `Воркер анализа не запустился: ${e.message || 'неизвестная ошибка'}. Попробуй открыть через npm run dev.`, progress: null });
};

const send = (m: ToWorker): void => worker.postMessage(m);

export function openFile(f: File): void {
  set({ progress: { stage: 'Чтение файла', fraction: 0 }, error: null });
  send({ type: 'scan', file: f, name: f.name });
}

export function openLog(index: number): void {
  set({ progress: { stage: 'Открываю лог', fraction: 0 }, error: null });
  send({ type: 'open', logIndex: index });
}

export function setAnalysisRange(range: { t0: number; t1: number } | null): void {
  set({ progress: { stage: 'Пересчёт', fraction: 0.5 } });
  send({ type: 'setRange', range });
}

export function fetchSeries(keys: string[], t0: number, t1: number, width: number): Promise<{ x: Float64Array; ys: Float32Array[]; raw: boolean }> {
  const reqId = ++reqSeq;
  return new Promise((res) => {
    pending.set(reqId, res);
    send({ type: 'series', reqId, keys, t0, t1, width });
  });
}

let filtersRequested = false;
subscribe((s, ch) => {
  if (ch.has('filters') && !s.filters) filtersRequested = false;
});
/** базовая оценка фильтров — лениво, при первом показе вкладки */
export function ensureFilters(): void {
  if (state.filters || filtersRequested || !state.info) return;
  filtersRequested = true;
  set({ progress: { stage: 'Модель фильтров', fraction: 0.1 } });
  send({ type: 'filtersInit' });
}

let sandboxReq = 0;
let sandboxTimer: ReturnType<typeof setTimeout> | null = null;
/** пересчёт песочницы с задержкой (ползунки двигаются часто) */
export function requestSandbox(params: FilterParams): void {
  set({ sandbox: params, sandboxBusy: true });
  if (sandboxTimer) clearTimeout(sandboxTimer);
  sandboxTimer = setTimeout(() => {
    sandboxReq++;
    send({ type: 'filtersEval', reqId: sandboxReq, params });
  }, 250);
}

let ratesRequested = false;
subscribe((s, ch) => {
  if (ch.has('rates') && !s.rates) ratesRequested = false;
});
/** база рейтов — лениво, при первом показе вкладки */
export function ensureRates(): void {
  if (state.rates || state.ratesWhy || ratesRequested || !state.info) return;
  ratesRequested = true;
  send({ type: 'ratesInit' });
}

let ratesReq = 0;
let ratesTimer: ReturnType<typeof setTimeout> | null = null;
/** пересчёт setpoint под рейты песочницы (кривые считаются в UI мгновенно, это — манёвры) */
export function requestRatesEval(profile: RateProfile, delayMs = 150): void {
  set({ ratesSandbox: profile, ratesBusy: true });
  if (ratesTimer) clearTimeout(ratesTimer);
  ratesTimer = setTimeout(() => {
    ratesReq++;
    send({ type: 'ratesEval', reqId: ratesReq, profile });
  }, delayMs);
}
