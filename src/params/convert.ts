// Перенос настроек (`diff` / `diff all`) со старой прошивки на новую: переименования параметров,
// параметры, у которых поменялся смысл, и параметры, которых в новой прошивке нет.
// Как конвертер имён у fpvpidtune.com; чат Blackbox 2.0 предупреждает переносить диф «вслепую».
// Имена по версиям — bf-names.json (settings.c / parameter_names.h на GitHub по тегам);
// пары переименований проверены: старое имя есть в старой версии, новое — в новой.

import names from './bf-names.json';

export type BfVersion = '4.2.11' | '4.3.0' | '4.4.0' | '4.5.0' | '2025.12.1' | '2026.6.1';
export const BF_VERSIONS = Object.keys(names.versions) as BfVersion[];
const CODE: Record<BfVersion, number> = { '4.2.11': 4_002_011, '4.3.0': 4_003_000, '4.4.0': 4_004_000, '4.5.0': 4_005_000, '2025.12.1': 2_025_012_001, '2026.6.1': 2_026_006_001 };
const ORDER = (v: BfVersion): number => BF_VERSIONS.indexOf(v);

interface RenameDef {
  /** версия, где появилось новое имя */
  at: BfVersion;
  old: string;
  new: string;
  /** смысл или единицы поменялись: значение не переносим, только подсказка */
  changed?: string;
}

const R = (at: BfVersion, old: string, nw: string, changed?: string): RenameDef => ({ at, old, new: nw, changed });

export const RENAMES: RenameDef[] = [
  // 4.3: фильтры переименованы по схеме lpf1/lpf2, RPM-фильтр и динамический ХХ — свои имена
  R('4.3.0', 'gyro_lowpass_type', 'gyro_lpf1_type'), R('4.3.0', 'gyro_lowpass_hz', 'gyro_lpf1_static_hz'),
  R('4.3.0', 'gyro_lowpass2_type', 'gyro_lpf2_type'), R('4.3.0', 'gyro_lowpass2_hz', 'gyro_lpf2_static_hz'),
  R('4.3.0', 'dyn_lpf_gyro_min_hz', 'gyro_lpf1_dyn_min_hz'), R('4.3.0', 'dyn_lpf_gyro_max_hz', 'gyro_lpf1_dyn_max_hz'),
  R('4.3.0', 'dterm_lowpass_type', 'dterm_lpf1_type'), R('4.3.0', 'dterm_lowpass_hz', 'dterm_lpf1_static_hz'),
  R('4.3.0', 'dterm_lowpass2_type', 'dterm_lpf2_type'), R('4.3.0', 'dterm_lowpass2_hz', 'dterm_lpf2_static_hz'),
  R('4.3.0', 'dyn_lpf_dterm_min_hz', 'dterm_lpf1_dyn_min_hz'), R('4.3.0', 'dyn_lpf_dterm_max_hz', 'dterm_lpf1_dyn_max_hz'),
  R('4.3.0', 'dyn_lpf_dterm_curve_expo', 'dterm_lpf1_dyn_expo'),
  R('4.3.0', 'gyro_rpm_notch_harmonics', 'rpm_filter_harmonics'), R('4.3.0', 'gyro_rpm_notch_min', 'rpm_filter_min_hz'),
  R('4.3.0', 'rpm_notch_lpf', 'rpm_filter_lpf_hz'),
  R('4.3.0', 'gyro_rpm_notch_q', 'rpm_filter_q', 'добротность RPM-фильтра пересчитана — оставь значение новой прошивки по умолчанию'),
  R('4.3.0', 'idle_min_rpm', 'dyn_idle_min_rpm'), R('4.3.0', 'idle_max_increase', 'dyn_idle_max_increase'),
  R('4.3.0', 'idle_p', 'dyn_idle_p_gain', 'регулятор динамического ХХ переделан — оставь значение по умолчанию'),
  R('4.3.0', 'idle_adjustment_speed', 'dyn_idle_i_gain', 'регулятор динамического ХХ переделан — оставь значение по умолчанию'),
  R('4.3.0', 'ff_interpolate_sp', 'feedforward_averaging', 'варианты усреднения FF другие — выбери заново (или пресет линка)'),
  R('4.3.0', 'ff_smooth_factor', 'feedforward_smooth_factor'), R('4.3.0', 'ff_boost', 'feedforward_boost'),
  R('4.3.0', 'ff_max_rate_limit', 'feedforward_max_rate_limit'),
  R('4.3.0', 'ff_spike_limit', 'feedforward_jitter_factor', 'это другой механизм (подавление дрожи) — поставь через пресет сглаживания линка'),
  R('4.3.0', 'blackbox_p_ratio', 'blackbox_sample_rate', 'другие единицы: теперь доля циклов PID (1/1, 1/2, 1/4…) — выставь заново (кнопка «Подготовить запись лога»)'),
  R('4.3.0', 'dyn_notch_width_percent', 'dyn_notch_count', 'вместо ширины теперь число нотчей — обычно 1–3'),
  R('4.3.0', 'd_min_boost_gain', 'd_max_gain'), R('4.3.0', 'd_min_advance', 'd_max_advance'),
  // 2025.12: D min → D max — смысл перевёрнут, значения переставляются (см. dSwap)
  R('2025.12.1', 'simplified_dmax_gain', 'simplified_d_max_gain'),
];

export interface ConvertNote {
  line: string;
  kind: 'renamed' | 'changed' | 'removed' | 'dswap';
  text: string;
}

export interface ConvertResult {
  lines: string[];
  notes: ConvertNote[];
}

const SET = /^set\s+([a-z0-9_]+)\s*=\s*(.+?)\s*$/;

/**
 * Перенести строки diff с прошивки `from` на `to` (только вперёд по версиям). Строки, которые не
 * `set`, переносятся как есть. Не узнанный в новой версии параметр — закомментирован с пометкой.
 */
export function convertDiff(text: string, from: BfVersion, to: BfVersion): ConvertResult {
  const notes: ConvertNote[] = [];
  const target = new Set((names.versions as Record<string, string[]>)[to]);
  const steps = RENAMES.filter((r) => ORDER(r.at) > ORDER(from) && ORDER(r.at) <= ORDER(to));
  const out: string[] = [];
  const dOld: Record<string, string> = {}, dMinOld: Record<string, string> = {};
  const crossD = CODE[from] < 2_025_012_000 && CODE[to] >= 2_025_012_000;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const m = line.match(SET);
    if (!m) {
      out.push(line);
      continue;
    }
    let name = m[1];
    const val = m[2];
    // D min → D max (2025.12): старое d_<ось> — максимум, d_min_<ось> — база; новое d_<ось> — база,
    // d_max_<ось> — максимум. Запоминаем и выводим пары после цикла.
    const dm = name.match(/^d_(min_)?(roll|pitch|yaw)$/);
    if (crossD && dm) {
      (dm[1] ? dMinOld : dOld)[dm[2]] = val;
      continue;
    }
    let changed: string | undefined;
    for (const r of steps) {
      if (r.old !== name) continue;
      notes.push({ line, kind: r.changed ? 'changed' : 'renamed', text: r.changed ? `${r.old} → ${r.new}: ${r.changed}` : `${r.old} → ${r.new}` });
      name = r.new;
      changed = r.changed ?? changed;
    }
    if (changed) {
      out.push(`# ${name}: было ${val} — ${changed}`);
      continue;
    }
    if (!target.has(name)) {
      notes.push({ line, kind: 'removed', text: `${name}: в ${to} такого параметра нет` });
      out.push(`# ${line} — нет в ${to}`);
      continue;
    }
    out.push(`set ${name} = ${val}`);
  }
  if (crossD) {
    for (const ax of ['roll', 'pitch', 'yaw']) {
      if (dOld[ax] === undefined && dMinOld[ax] === undefined) continue;
      if (dMinOld[ax] !== undefined) out.push(`set d_${ax} = ${dMinOld[ax]}`);
      if (dOld[ax] !== undefined) out.push(`set d_max_${ax} = ${dOld[ax]}`);
      notes.push({ line: `d_${ax} / d_min_${ax}`, kind: 'dswap', text: `с 2025.12 d_${ax} — базовый D (был d_min_${ax} = ${dMinOld[ax] ?? '—'}), d_max_${ax} — максимум (был d_${ax} = ${dOld[ax] ?? '—'})` });
    }
  }
  return { lines: out, notes };
}
