// Справочник параметров Betaflight: имя в CLI, диапазон, дефолт, с какой версии.
// Пока — только параметры фильтров (этап 2). Источник: settings.c / *_config.h BF 4.3+.
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
const V43 = 4_003_000;

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
