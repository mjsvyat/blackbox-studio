// Сообщения между UI и воркером.

import type { Card } from '../analysis/summary';
import type { Anomaly, ModeSpan } from '../analysis/health';
import type { Burst, ClassifiedPeak } from '../analysis/noise';
import type { Spectrogram } from '../dsp/spectrum';
import type { FileStructure } from '../decoder/scan';
import type { LogEvent } from '../decoder/decoder';
import type { FilterBaseline, FilterEval } from '../filters/evaluate';
import type { FilterParams } from '../filters/settings';
import type { RatesBase, RatesEval } from '../rates/analyze';
import type { RateProfile } from '../rates/rates';

export type ToWorker =
  | { type: 'scan'; file: Blob; name: string }
  | { type: 'open'; logIndex: number }
  | { type: 'setRange'; range: { t0: number; t1: number } | null }
  | { type: 'series'; reqId: number; keys: string[]; t0: number; t1: number; width: number }
  | { type: 'filtersInit' }
  | { type: 'filtersEval'; reqId: number; params: FilterParams }
  | { type: 'ratesInit' }
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
  cards: Card[];
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
  | { type: 'error'; message: string };

export type { LogEvent };
