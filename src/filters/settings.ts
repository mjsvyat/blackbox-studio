// Настройки фильтров: чтение из заголовка лога (имена заголовка ≠ имена CLI),
// пересчёт Simplified Tuning (simplified_tuning.c), генерация CLI.

import { nums } from '../decoder/header';

/** плоский набор значений под именами CLI */
export type FilterParams = Record<string, number>;

/** доп. сведения, нужные модели, но не меняемые в примерке */
export interface FilterContext {
  gyroLooptimeUs: number;
  pidLooptimeUs: number;
  motorPoles: number;
  dshotBidir: boolean;
  rpmWeights: number[];
  /** D-gain по осям (rollPID[2] …) */
  dGain: number[];
  tpaMode: number;
  tpaRate: number;
  tpaBreakpoint: number;
  fwCode: number;
}

const one = (H: Record<string, string>, k: string, i = 0, def = 0): number => {
  const a = nums(H, k);
  return a.length > i && Number.isFinite(a[i]) ? a[i] : def;
};

export function paramsFromHeader(H: Record<string, string>): FilterParams {
  const p: FilterParams = {};
  const copy = (cli: string, hdr = cli, i = 0): void => {
    if (H[hdr] !== undefined) p[cli] = one(H, hdr, i);
  };
  copy('gyro_lpf1_type');
  copy('gyro_lpf1_static_hz');
  copy('gyro_lpf1_dyn_min_hz', 'gyro_lpf1_dyn_hz', 0);
  copy('gyro_lpf1_dyn_max_hz', 'gyro_lpf1_dyn_hz', 1);
  copy('gyro_lpf1_dyn_expo');
  copy('gyro_lpf2_type');
  copy('gyro_lpf2_static_hz');
  copy('gyro_notch1_hz', 'gyro_notch_hz', 0);
  copy('gyro_notch2_hz', 'gyro_notch_hz', 1);
  copy('gyro_notch1_cutoff', 'gyro_notch_cutoff', 0);
  copy('gyro_notch2_cutoff', 'gyro_notch_cutoff', 1);
  copy('dyn_notch_count');
  copy('dyn_notch_q');
  copy('dyn_notch_min_hz');
  copy('dyn_notch_max_hz');
  copy('rpm_filter_harmonics');
  copy('rpm_filter_q');
  copy('rpm_filter_min_hz');
  copy('rpm_filter_fade_range_hz');
  copy('rpm_filter_lpf_hz');
  copy('dterm_lpf1_type');
  copy('dterm_lpf1_static_hz');
  copy('dterm_lpf1_dyn_min_hz', 'dterm_lpf1_dyn_hz', 0);
  copy('dterm_lpf1_dyn_max_hz', 'dterm_lpf1_dyn_hz', 1);
  copy('dterm_lpf1_dyn_expo');
  copy('dterm_lpf2_type');
  copy('dterm_lpf2_static_hz');
  copy('dterm_notch_hz');
  copy('dterm_notch_cutoff');
  copy('simplified_gyro_filter');
  copy('simplified_gyro_filter_multiplier');
  copy('simplified_dterm_filter');
  copy('simplified_dterm_filter_multiplier');
  return p;
}

export function contextFromHeader(H: Record<string, string>, fwCode: number): FilterContext {
  const looptime = one(H, 'looptime', 0, 125);
  const denom = one(H, 'pid_process_denom', 0, 1) || 1;
  const w = nums(H, 'rpm_filter_weights');
  return {
    gyroLooptimeUs: looptime,
    pidLooptimeUs: looptime * denom,
    motorPoles: one(H, 'motor_poles', 0, 14),
    dshotBidir: one(H, 'dshot_bidir', 0, 0) === 1,
    rpmWeights: [0, 1, 2].map((i) => (w.length > i ? w[i] : 100)),
    dGain: ['rollPID', 'pitchPID', 'yawPID'].map((k) => one(H, k, 2, 0)),
    tpaMode: one(H, 'tpa_mode', 0, 1),
    tpaRate: one(H, 'tpa_rate', 0, 0),
    tpaBreakpoint: one(H, 'tpa_breakpoint', 0, 1350),
    fwCode,
  };
}

// дефолты, от которых считает Simplified Tuning (BF 4.3+)
const GYRO_LPF1_DYN_MIN_HZ_DEFAULT = 250;
const GYRO_LPF1_DYN_MAX_HZ_DEFAULT = 500;
const GYRO_LPF2_HZ_DEFAULT = 500;
const DTERM_LPF1_DYN_MIN_HZ_DEFAULT = 75;
const DTERM_LPF1_DYN_MAX_HZ_DEFAULT = 150;
const DTERM_LPF2_HZ_DEFAULT = 150;
const LPF_MAX_HZ = 1000;
const DYN_LPF_MAX_HZ = 1000;

const scale = (def: number, mult: number, max: number): number => Math.min(max, Math.max(0, Math.floor((def * mult) / 100)));

/**
 * Как calculateNewGyroFilterValues / calculateNewDTermFilterValues: множитель меняет
 * только включённые (ненулевые) фильтры. Возвращает новые параметры.
 */
export function applySimplified(p: FilterParams): FilterParams {
  const q = { ...p };
  if (q.simplified_gyro_filter) {
    const m = q.simplified_gyro_filter_multiplier ?? 100;
    if (q.gyro_lpf1_dyn_min_hz) {
      q.gyro_lpf1_dyn_min_hz = scale(GYRO_LPF1_DYN_MIN_HZ_DEFAULT, m, DYN_LPF_MAX_HZ);
      q.gyro_lpf1_dyn_max_hz = scale(GYRO_LPF1_DYN_MAX_HZ_DEFAULT, m, DYN_LPF_MAX_HZ);
    }
    if (q.gyro_lpf1_static_hz) q.gyro_lpf1_static_hz = scale(GYRO_LPF1_DYN_MIN_HZ_DEFAULT, m, LPF_MAX_HZ);
    if (q.gyro_lpf2_static_hz) q.gyro_lpf2_static_hz = scale(GYRO_LPF2_HZ_DEFAULT, m, LPF_MAX_HZ);
  }
  if (q.simplified_dterm_filter) {
    const m = q.simplified_dterm_filter_multiplier ?? 100;
    if (q.dterm_lpf1_dyn_min_hz) {
      q.dterm_lpf1_dyn_min_hz = scale(DTERM_LPF1_DYN_MIN_HZ_DEFAULT, m, DYN_LPF_MAX_HZ);
      q.dterm_lpf1_dyn_max_hz = scale(DTERM_LPF1_DYN_MAX_HZ_DEFAULT, m, DYN_LPF_MAX_HZ);
    }
    if (q.dterm_lpf1_static_hz) q.dterm_lpf1_static_hz = scale(DTERM_LPF1_DYN_MIN_HZ_DEFAULT, m, LPF_MAX_HZ);
    if (q.dterm_lpf2_static_hz) q.dterm_lpf2_static_hz = scale(DTERM_LPF2_HZ_DEFAULT, m, LPF_MAX_HZ);
  }
  return q;
}

/** параметры, которые пересчитывает simplified-множитель (для предупреждения) */
export const SIMPLIFIED_GYRO_TARGETS = ['gyro_lpf1_dyn_min_hz', 'gyro_lpf1_dyn_max_hz', 'gyro_lpf1_static_hz', 'gyro_lpf2_static_hz'];
export const SIMPLIFIED_DTERM_TARGETS = ['dterm_lpf1_dyn_min_hz', 'dterm_lpf1_dyn_max_hz', 'dterm_lpf1_static_hz', 'dterm_lpf2_static_hz'];

/** совпадают ли текущие значения с тем, что дал бы simplified-множитель */
export function simplifiedConsistent(p: FilterParams): { gyro: boolean; dterm: boolean } {
  const s = applySimplified(p);
  return {
    gyro: !p.simplified_gyro_filter || SIMPLIFIED_GYRO_TARGETS.every((k) => (s[k] ?? 0) === (p[k] ?? 0)),
    dterm: !p.simplified_dterm_filter || SIMPLIFIED_DTERM_TARGETS.every((k) => (s[k] ?? 0) === (p[k] ?? 0)),
  };
}

// генератор CLI общий для всех вкладок — params/registry.ts
export { cliDiff } from '../params/registry';
export type { CliResult } from '../params/registry';
