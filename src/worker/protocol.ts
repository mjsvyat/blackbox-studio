import type { LogCheck } from '../analysis/logcheck';
// Сообщения между UI и воркером.

import type { FreqView } from '../sysid/chirp';
import type { ClassInfo } from '../config/classes';
import type { Card } from '../analysis/summary';
import type { Anomaly, LinkStats, ModeSpan, MotorStats, PowerStats, ThrottleDetail } from '../analysis/health';
import type { Burst, ClassifiedPeak } from '../analysis/noise';
import type { Spectrogram } from '../dsp/spectrum';
import type { FileStructure } from '../decoder/scan';
import type { LogEvent } from '../decoder/decoder';
import type { FilterBaseline, FilterEval } from '../filters/evaluate';
import type { FilterParams } from '../filters/settings';
import type { RatesBase, RatesEval } from '../rates/analyze';
import type { RateProfile } from '../rates/rates';
import type { PidResult } from '../pid/analyze';
import type { SimplifiedPids } from '../pid/gains';
import type { AdvisorResult, BoardKnowledge } from '../advisor/advisor';
import type { SessionSnapshot } from '../sessions/snapshot';
import type { AxisForecast } from '../sysid/predict';

export type ToWorker =
  | { type: 'scan'; file: Blob; name: string }
  | { type: 'open'; logIndex: number }
  | { type: 'setRange'; range: { t0: number; t1: number } | null }
  | { type: 'setClass'; cls: string | null }
  | { type: 'series'; reqId: number; keys: string[]; t0: number; t1: number; width: number }
  | { type: 'filtersInit' }
  | { type: 'filtersEval'; reqId: number; params: FilterParams }
  | { type: 'ratesInit' }
  | { type: 'pidInit' }
  | { type: 'adviceInit'; board?: BoardKnowledge }
  | { type: 'pidPredict'; reqId: number; changes: Record<string, number>; bandScale: number }
  | { type: 'snapshot'; reqId: number; board?: BoardKnowledge }
  | { type: 'ratesEval'; reqId: number; profile: RateProfile };

export interface FiltersPayload {
  base: FilterBaseline;
  params: FilterParams;
  fwCode: number;
  simplified: { gyro: boolean; dterm: boolean };
  /** дорожки центров дин. нотчей и среза LPF1 по времени (прорежено) */
  track: { t: Float32Array; dyn: Float32Array[][]; lpf1: Float32Array };
  quantFloorDb: number;
  noiseStatus: string;
}

/** рейты: база на текущих настройках (см. rates/analyze.ts) */
export interface RatesPayload extends RatesBase {
  fwCode: number;
}

/** отработка PID (pid/analyze.ts) + настройки для советчика */
export interface PidPayload extends PidResult {
  fwCode: number;
  simplified: { s: SimplifiedPids; dExtraName: string } | null;
  /** модель оси (этап 7): кривая модели на текущих коэффициентах и качество */
  model: { t: number[]; axes: (AxisForecast & { tauMs: number; plantDelayMs: number; pFit: number; dFit: number; fFit: number; source: 'step' | 'chirp' })[] } | null;
  /** частотная характеристика, запасы, chirp (C) */
  freq: FreqView | null;
}

export interface AdvicePayload extends AdvisorResult {
  fwCode: number;
}

export interface AxisSpectra {
  axis: number;
  /** СПМ, дБ; частоты = k·df */
  unfilt: Float32Array | null;
  filt: Float32Array;
  dterm: Float32Array | null;
  rmsUnfilt: number | null;
  rmsFilt: number;
  reductionDb: number | null;
  rmsDterm: number | null;
  rmsMid: number;
  peaks: ClassifiedPeak[];
}

export interface AnalysisPayload {
  /** класс борта, по порогам которого посчитан светофор */
  cls: ClassInfo;
  cards: Card[];
  logCheck: LogCheck;
  maskSegments: [number, number][];
  maskSeconds: number;
  excluded: Record<string, number>;
  range: { t0: number; t1: number } | null;
  noise: {
    df: number;
    fs: number;
    nyquist: number;
    segments: number;
    motorHzMedian: number | null;
    axes: AxisSpectra[];
    thrSpec: { unfilt: Spectrogram | null; filt: Spectrogram }[];
    timeSpec: { unfilt: Spectrogram | null; filt: Spectrogram }[];
    bursts: Burst[];
    degraded: string | null;
  };
  anomalies: Anomaly[];
  /** этап 8: подробности для «Моторы и питание» и «Связь» */
  health: { motors: MotorStats; power: PowerStats; link: LinkStats; thr: ThrottleDetail };
}

export interface LogInfo {
  index: number;
  durationS: number;
  frames: number;
  fs: number;
  nyquist: number;
  firmware: string;
  board: string;
  craft: string;
  datetime: string;
  hasGyroUnfilt: boolean;
  hasErpm: boolean;
  motorCount: number;
  cells: number;
  header: Record<string, string>;
  events: { t: number; name: string; detail: string }[];
  modes: ModeSpan[];
  holes: [number | null, number | null][];
  warnings: string[];
  truncatedAtWrap: number | null;
}

export type FromWorker =
  | { type: 'progress'; stage: string; fraction: number }
  | { type: 'scanned'; structure: FileStructure; name: string }
  | { type: 'opened'; info: LogInfo; analysis: AnalysisPayload }
  | { type: 'analysis'; analysis: AnalysisPayload }
  | { type: 'series'; reqId: number; x: Float64Array; ys: Float32Array[]; raw: boolean }
  | { type: 'filters'; payload: FiltersPayload }
  | { type: 'filtersEval'; reqId: number; ev: FilterEval }
  | { type: 'rates'; payload: RatesPayload | null; why?: string }
  | { type: 'ratesEval'; reqId: number; ev: RatesEval }
  | { type: 'pid'; payload: PidPayload }
  | { type: 'pidPredict'; reqId: number; axes: AxisForecast[] }
  | { type: 'advice'; payload: AdvicePayload }
  | { type: 'snapshot'; reqId: number; snap: SessionSnapshot }
  | { type: 'error'; message: string };

export type { LogEvent };
