// Справочник параметров Betaflight: имя в CLI, диапазон, дефолт, с какой версии.
// Фильтры (этап 2) и рейты (этап 3). Источник: settings.c / *_config.h BF 4.3+.
// Версия: code = major*1e6 + minor*1e3 + patch (см. parseFirmware).

export interface ParamDef {
  name: string;
  min: number;
  max: number;
  def: number;
  /** варианты для перечислений: значение → подпись */
  options?: string[];
  /** с какой версии параметр есть под этим именем */
  since?: number;
  /** до какой версии (не включая) */
  until?: number;
  unit?: string;
  label: string;
  help?: string;
}

const LPF_TYPES = ['PT1', 'BIQUAD', 'PT2', 'PT3'];
const V41 = 4_001_000;
const V43 = 4_003_000;
const V2025_12 = 2_025_012_000;
const RATES_TYPES = ['BETAFLIGHT', 'RACEFLIGHT', 'KISS', 'ACTUAL', 'QUICK'];

/** PID по осям (settings.c: PID_GAIN_MAX 250, F_GAIN_MAX 1000); d_min ≤ 4.5, d_max ≥ 2025.12 */
const pidAxis = (ax: string, axRu: string): ParamDef[] => [
  { name: `p_${ax}`, min: 0, max: 250, def: 45, label: `${axRu}: P`, help: 'pid-gains' },
  { name: `i_${ax}`, min: 0, max: 250, def: 80, label: `${axRu}: I`, help: 'pid-gains' },
  { name: `d_${ax}`, min: 0, max: 250, def: 30, label: `${axRu}: D`, help: 'pid-gains' },
  { name: `f_${ax}`, min: 0, max: 1000, def: 120, label: `${axRu}: F (feedforward)`, help: 'pid-gains' },
  { name: `d_min_${ax}`, min: 0, max: 250, def: 30, until: V2025_12, label: `${axRu}: D min`, help: 'pid-gains' },
  { name: `d_max_${ax}`, min: 0, max: 250, def: 40, since: V2025_12, label: `${axRu}: D max`, help: 'pid-gains' },
];
const simp = (name: string, min: number, label: string, extra: Partial<ParamDef> = {}): ParamDef =>
  ({ name, min, max: 200, def: 100, since: V43, label, help: 'pid-simplified', ...extra });

/** параметры рейтов по осям: rc_rate / srate / expo / rate_limit (rates/rates.ts) */
const rateAxis = (ax: string, axRu: string): ParamDef[] => [
  { name: `${ax}_rc_rate`, min: 1, max: 255, def: 7, label: `${axRu}: rc_rate (смысл зависит от типа)`, help: 'rates-params' },
  { name: `${ax}_srate`, min: 0, max: 255, def: 67, label: `${axRu}: rate / super rate`, help: 'rates-params' },
  { name: `${ax}_expo`, min: 0, max: 100, def: 0, label: `${axRu}: expo`, help: 'rates-params' },
  { name: `${ax}_rate_limit`, min: 200, max: 1998, def: 1998, unit: '°/с', label: `${axRu}: ограничение`, help: 'rates-params' },
];

export const PARAMS: ParamDef[] = [
  { name: 'gyro_lpf1_type', min: 0, max: 3, def: 0, options: LPF_TYPES, since: V43, label: 'Gyro LPF1: тип', help: 'filter-lpf' },
  { name: 'gyro_lpf1_static_hz', min: 0, max: 1000, def: 250, unit: 'Гц', since: V43, label: 'Gyro LPF1: срез (0 — выкл.)', help: 'filter-lpf' },
  { name: 'gyro_lpf1_dyn_min_hz', min: 0, max: 1000, def: 250, unit: 'Гц', since: V43, label: 'Gyro LPF1 динамический: мин. (0 — статический)', help: 'filter-dyn-lpf' },
  { name: 'gyro_lpf1_dyn_max_hz', min: 0, max: 1000, def: 500, unit: 'Гц', since: V43, label: 'Gyro LPF1 динамический: макс.', help: 'filter-dyn-lpf' },
  { name: 'gyro_lpf1_dyn_expo', min: 0, max: 10, def: 5, since: V43, label: 'Gyro LPF1 динамический: экспо', help: 'filter-dyn-lpf' },
  { name: 'gyro_lpf2_type', min: 0, max: 3, def: 0, options: LPF_TYPES, since: V43, label: 'Gyro LPF2: тип', help: 'filter-lpf' },
  { name: 'gyro_lpf2_static_hz', min: 0, max: 1000, def: 500, unit: 'Гц', since: V43, label: 'Gyro LPF2: срез (0 — выкл.)', help: 'filter-lpf' },
  { name: 'gyro_notch1_hz', min: 0, max: 1000, def: 0, unit: 'Гц', label: 'Статический нотч 1: центр', help: 'filter-static-notch' },
  { name: 'gyro_notch1_cutoff', min: 0, max: 1000, def: 0, unit: 'Гц', label: 'Статический нотч 1: нижняя граница', help: 'filter-static-notch' },
  { name: 'gyro_notch2_hz', min: 0, max: 1000, def: 0, unit: 'Гц', label: 'Статический нотч 2: центр', help: 'filter-static-notch' },
  { name: 'gyro_notch2_cutoff', min: 0, max: 1000, def: 0, unit: 'Гц', label: 'Статический нотч 2: нижняя граница', help: 'filter-static-notch' },
  { name: 'dyn_notch_count', min: 0, max: 7, def: 3, since: V43, label: 'Динамический нотч: число нотчей (0 — выкл.)', help: 'filter-dyn-notch' },
  { name: 'dyn_notch_q', min: 1, max: 1000, def: 300, since: V43, label: 'Динамический нотч: Q ×100', help: 'filter-dyn-notch' },
  { name: 'dyn_notch_min_hz', min: 20, max: 250, def: 150, unit: 'Гц', since: V43, label: 'Динамический нотч: мин. частота', help: 'filter-dyn-notch' },
  { name: 'dyn_notch_max_hz', min: 200, max: 1000, def: 600, unit: 'Гц', since: V43, label: 'Динамический нотч: макс. частота', help: 'filter-dyn-notch' },
  { name: 'rpm_filter_harmonics', min: 0, max: 3, def: 3, label: 'RPM-фильтр: гармоник (0 — выкл.)', help: 'filter-rpm' },
  { name: 'rpm_filter_q', min: 250, max: 3000, def: 500, label: 'RPM-фильтр: Q ×100', help: 'filter-rpm' },
  { name: 'rpm_filter_min_hz', min: 30, max: 200, def: 100, unit: 'Гц', label: 'RPM-фильтр: мин. частота', help: 'filter-rpm' },
  { name: 'rpm_filter_fade_range_hz', min: 0, max: 1000, def: 50, unit: 'Гц', label: 'RPM-фильтр: зона затухания', help: 'filter-rpm' },
  { name: 'rpm_filter_lpf_hz', min: 100, max: 500, def: 150, unit: 'Гц', label: 'RPM-фильтр: сглаживание оборотов', help: 'filter-rpm' },
  { name: 'dterm_lpf1_type', min: 0, max: 3, def: 0, options: LPF_TYPES, since: V43, label: 'D-term LPF1: тип', help: 'filter-dterm' },
  { name: 'dterm_lpf1_static_hz', min: 0, max: 1000, def: 75, unit: 'Гц', since: V43, label: 'D-term LPF1: срез', help: 'filter-dterm' },
  { name: 'dterm_lpf1_dyn_min_hz', min: 0, max: 1000, def: 75, unit: 'Гц', since: V43, label: 'D-term LPF1 динамический: мин.', help: 'filter-dterm' },
  { name: 'dterm_lpf1_dyn_max_hz', min: 0, max: 1000, def: 150, unit: 'Гц', since: V43, label: 'D-term LPF1 динамический: макс.', help: 'filter-dterm' },
  { name: 'dterm_lpf1_dyn_expo', min: 0, max: 10, def: 5, since: V43, label: 'D-term LPF1 динамический: экспо', help: 'filter-dterm' },
  { name: 'dterm_lpf2_type', min: 0, max: 3, def: 0, options: LPF_TYPES, since: V43, label: 'D-term LPF2: тип', help: 'filter-dterm' },
  { name: 'dterm_lpf2_static_hz', min: 0, max: 1000, def: 150, unit: 'Гц', since: V43, label: 'D-term LPF2: срез', help: 'filter-dterm' },
  { name: 'dterm_notch_hz', min: 0, max: 1000, def: 0, unit: 'Гц', label: 'D-term нотч: центр', help: 'filter-static-notch' },
  { name: 'dterm_notch_cutoff', min: 0, max: 1000, def: 0, unit: 'Гц', label: 'D-term нотч: нижняя граница', help: 'filter-static-notch' },
  { name: 'simplified_gyro_filter', min: 0, max: 1, def: 1, options: ['OFF', 'ON'], since: V43, label: 'Simplified: фильтры гиро', help: 'filter-simplified' },
  { name: 'simplified_gyro_filter_multiplier', min: 10, max: 200, def: 100, since: V43, label: 'Simplified: множитель фильтров гиро', help: 'filter-simplified' },
  { name: 'simplified_dterm_filter', min: 0, max: 1, def: 1, options: ['OFF', 'ON'], since: V43, label: 'Simplified: фильтры D-term', help: 'filter-simplified' },
  { name: 'simplified_dterm_filter_multiplier', min: 10, max: 200, def: 100, since: V43, label: 'Simplified: множитель фильтров D-term', help: 'filter-simplified' },
  { name: 'rates_type', min: 0, max: 4, def: 3, options: RATES_TYPES, since: V41, label: 'Тип рейтов', help: 'rates-type' },
  { name: 'quickrates_rc_expo', min: 0, max: 1, def: 0, options: ['OFF', 'ON'], since: V43, label: 'Quick: expo как в RC Rate', help: 'rates-type' },
  ...pidAxis('roll', 'Ролл'),
  ...pidAxis('pitch', 'Питч'),
  ...pidAxis('yaw', 'Яв'),
  { name: 'simplified_pids_mode', min: 0, max: 2, def: 2, options: ['OFF', 'RP', 'RPY'], since: V43, label: 'Simplified PID: режим', help: 'pid-simplified' },
  simp('simplified_master_multiplier', 0, 'Simplified: общий множитель'),
  simp('simplified_pi_gain', 0, 'Simplified: P и I (отслеживание)'),
  simp('simplified_i_gain', 0, 'Simplified: I (дрейф)'),
  simp('simplified_d_gain', 0, 'Simplified: D (демпфирование)'),
  simp('simplified_dmax_gain', 0, 'Simplified: динамика D', { until: V2025_12 }),
  simp('simplified_d_max_gain', 0, 'Simplified: динамика D', { since: V2025_12 }),
  simp('simplified_feedforward_gain', 0, 'Simplified: feedforward (резкость)'),
  simp('simplified_pitch_d_gain', 0, 'Simplified: D питча к роллу'),
  simp('simplified_pitch_pi_gain', 0, 'Simplified: P и I питча к роллу'),
  ...rateAxis('roll', 'Ролл'),
  ...rateAxis('pitch', 'Питч'),
  ...rateAxis('yaw', 'Яв'),
];

export const paramByName = new Map(PARAMS.map((p) => [p.name, p]));

/** есть ли параметр в этой версии прошивки */
export function paramAvailable(name: string, fwCode: number): boolean {
  const p = paramByName.get(name);
  if (!p) return false;
  if (p.since && fwCode && fwCode < p.since) return false;
  if (p.until && fwCode >= p.until) return false;
  return true;
}

export function clampParam(name: string, v: number): number {
  const p = paramByName.get(name);
  if (!p) return v;
  return Math.min(p.max, Math.max(p.min, Math.round(v)));
}

/** значение для CLI: перечисления — словом (BF CLI не принимает число для lookup-параметров) */
export function cliValue(name: string, v: number): string {
  const p = paramByName.get(name);
  return p?.options && p.options[v] !== undefined ? p.options[v] : String(v);
}

export interface CliResult {
  lines: string[];
  changed: { name: string; from: number | undefined; to: number }[];
  skipped: { name: string; why: string }[];
}

/** блок CLI: только изменённые параметры, в пределах диапазона своей версии */
export function cliDiff(from: Record<string, number>, to: Record<string, number>, fwCode: number): CliResult {
  const changed: CliResult['changed'] = [];
  const skipped: CliResult['skipped'] = [];
  for (const [k, v] of Object.entries(to)) {
    if (from[k] === v) continue;
    if (!paramAvailable(k, fwCode)) {
      skipped.push({ name: k, why: 'нет в этой версии прошивки' });
      continue;
    }
    const c = clampParam(k, v);
    changed.push({ name: k, from: from[k], to: c });
  }
  const lines = changed.map((c) => `set ${c.name} = ${cliValue(c.name, c.to)}`);
  if (lines.length) lines.push('save');
  return { lines, changed, skipped };
}
