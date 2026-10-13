// Советчик: прозрачные правила со стабильными ID и версиями. Каждое правило — условие
// на цифрах из анализа → изменение параметров (CLI) → тексты (src/i18n/ru.ts, T.adv)
// → входные цифры, на которых сработало (для трекинга на этапах 5–6).
// Пороги — config/analysis.json (advisor, noise, motors, power, pid, filters).
//
// Правила выбора за итерацию (ТЗ): сначала механика; не больше maxChanges параметрических
// советов; шаг ≤ stepPct; ничего за пределами диапазонов своей версии прошивки.
// При изменении логики правила — поднять его version и записать в _history раздела.

import type { ClassInfo } from '../config/classes';
import cfg from '../config/analysis.json';
import { applySimplified, FilterParams } from '../filters/settings';
import { clampParam, paramAvailable } from '../params/registry';
import { PidGains, SimplifiedPids, simplifiedPids, gainsToCli, simplifiedToCli } from '../pid/gains';
import type { PidResult } from '../pid/analyze';
import { AutotuneCtx, AutotuneSummary, autotunePolicy, autotuneSummary } from '../autotune/autotune';

type AdvisorCfg = typeof cfg.advisor;
/** пороги текущего прогона (по умолчанию — из конфига; тесты случаев могут подменить) */
let A: AdvisorCfg = cfg.advisor;

export type AdviceKind = 'mechanic' | 'tune' | 'info' | 'flight';

export interface Advice {
  id: string;
  version: number;
  kind: AdviceKind;
  severity: 'red' | 'yellow' | 'info';
  /** цифры, на которых сработало правило (уходят в тексты и в историю сессии) */
  inputs: Record<string, number | string>;
  /** параметр CLI → новое значение (только для kind = tune) */
  changes: Record<string, number>;
  /** параметр CLI → текущее значение */
  from: Record<string, number>;
  /** положения слайдеров Simplified Tuning: [имя, было, стало] */
  sliders: [string, number, number][];
  /** поднимает D или ослабляет фильтры — обязательное предупреждение «потрогай моторы» */
  safety: boolean;
  /** вкладка, где видна причина */
  tab: string;
  /** выбрано в эту итерацию; иначе — почему отложено */
  selected: boolean;
  deferred?: 'mechanics-first' | 'max-changes' | 'same-param' | 'one-risky' | 'caution' | 'stability'
    // автотюн (autotune.ts): пропы, только откат, уже откатывали, моторы не горячие, пол «не душить», горячо, нравится
    | 'props' | 'revert-only' | 'reverted' | 'not-hot' | 'floor' | 'hot' | 'happy';
  /** на этом борту правило уже ухудшало результат (этап 6) */
  caution?: { worse: number; n: number; incidents: string[] };
  /** ожидаемый эффект по точной модели (фильтры) — заполняет воркер */
  effect?: { delay100: [number, number]; delayD100: [number, number]; dterm: [number, number]; gyro: [number, number] };
  /** прогноз step response по модели оси (этап 7) — заполняет конвейер */
  forecast?: { axis: number; now: { overshoot: number; delayMs: number; settle: number }; overshoot: Range; delayMs: Range; settle: Range }[];
  priority: number;
}

export interface AdvisorInput {
  fwCode: number;
  logHz: number;
  hasUnfilt: boolean;
  noise: {
    unfilt: (number | null)[];
    filt: number[];
    dterm: (number | null)[];
    peaks: { axis: number; kind: string; hz: number; prominenceDb: number }[];
  } | null;
  filters: { params: FilterParams; status: string; reason: string } | null;
  pid: PidResult | null;
  simplified: { s: SimplifiedPids; dExtraName: string } | null;
  dKind: 'd_max' | 'd_min';
  motors: { satPct: number; spreadPct: number | null; desyncs: number; airClips: number; clipT: number[] };
  power: { resistanceMOhm: number | null; rippleP99: number | null; cells: number };
  /** знание о борте (профиль и история, этап 6) */
  board?: BoardKnowledge;
  /** настройка борта из заголовка лога и замеры, не связанные с полётом */
  setup?: { dynIdle: number | null; bidir: boolean | null; pidDenom: number; idleRpm: number | null };
  /** верх газа в полёте (99-й перцентиль, %) и задержка фильтров гиро на 100 Гц (мс) */
  flight?: { thrTop: number | null; gyroDelayMs: number | null; bench?: boolean };
  /** запасы устойчивости, которым можно верить (C: chirp или когерентный полёт) */
  stability?: { axis: number; pmDeg: number | null; gmDb: number | null; crossHz: number; source: 'chirp' | 'flight' }[];
}

export interface Range { mid: number; lo: number; hi: number }

export interface BoardKnowledge {
  /** класс борта (E2.2): пороги — с переопределениями класса (config/classes.ts) */
  cls?: string;
  /** во сколько раз расширять полосу прогноза PID (калибровка по истории, ≥ 1) */
  pidBandScale?: number;
  /** правила, отключённые для этого борта */
  disabledRules?: string[];
  /** D на этом борту поднимать нельзя (греет моторы) */
  dSensitive?: boolean;
  /** правило → сколько раз применено и сколько раз стало хуже, инциденты */
  caution?: Record<string, { worse: number; n: number; incidents: string[] }>;
  /** автотюн: пропы, ощущения пилота, стартовые настройки серии, откат (autotune.ts) */
  autotune?: AutotuneCtx;
}

export interface AdvisorResult {
  /** класс, по порогам которого считались советы; не откалиброван — интерфейс предупреждает */
  cls?: ClassInfo;
  advice: Advice[];
  /** суммарные изменения выбранных советов */
  from: Record<string, number>;
  to: Record<string, number>;
  /** что решил автотюн по этому полёту (если советы считались в автотюне) */
  autotune?: AutotuneSummary;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const maxOf = (a: (number | null | undefined)[]): number => Math.max(-Infinity, ...a.filter(isNum));

/** шаг множителя Simplified: ±stepPct % от текущего, кратно 5, в пределах 10…200 (фильтры) или 0…200 */
function stepSlider(v: number, dir: 1 | -1, min: number): number {
  const d = Math.max(5, Math.round((v * A.stepPct) / 100 / 5) * 5);
  return Math.min(200, Math.max(min, v + dir * d));
}
const stepGain = (v: number, dir: 1 | -1): number => Math.max(0, Math.round(v * (1 + (dir * A.stepPct) / 100)));

interface Ctx { inp: AdvisorInput; out: Advice[] }

function add(c: Ctx, a: Omit<Advice, 'selected' | 'from' | 'changes' | 'sliders' | 'safety' | 'tab'> & Partial<Pick<Advice, 'from' | 'changes' | 'sliders' | 'safety' | 'tab'>>): void {
  c.out.push({ from: {}, changes: {}, sliders: [], safety: false, tab: 'summary', selected: false, ...a });
}

/** изменение фильтров через множитель Simplified (если включён) или напрямую срезами */
function filterChange(p: FilterParams, which: 'gyro' | 'dterm', dir: 1 | -1): { from: Record<string, number>; changes: Record<string, number>; sliders: [string, number, number][] } {
  const on = which === 'gyro' ? p.simplified_gyro_filter : p.simplified_dterm_filter;
  const mk = which === 'gyro' ? 'simplified_gyro_filter_multiplier' : 'simplified_dterm_filter_multiplier';
  const keys = which === 'gyro'
    ? ['gyro_lpf1_dyn_min_hz', 'gyro_lpf1_dyn_max_hz', 'gyro_lpf1_static_hz', 'gyro_lpf2_static_hz']
    : ['dterm_lpf1_dyn_min_hz', 'dterm_lpf1_dyn_max_hz', 'dterm_lpf1_static_hz', 'dterm_lpf2_static_hz'];
  const from: Record<string, number> = {};
  const changes: Record<string, number> = {};
  if (on) {
    const m0 = p[mk] ?? 100;
    const m1 = stepSlider(m0, dir, 10);
    const q = applySimplified({ ...p, [mk]: m1 });
    from[mk] = m0;
    changes[mk] = m1;
    for (const k of keys) if ((p[k] ?? 0) !== (q[k] ?? 0)) { from[k] = p[k]; changes[k] = q[k]; }
    return { from, changes, sliders: [[mk, m0 / 100, m1 / 100]] };
  }
  for (const k of keys) {
    if (!p[k]) continue;
    from[k] = p[k];
    changes[k] = clampParam(k, Math.round((p[k] * (1 + (dir * A.stepPct) / 100)) / 5) * 5);
  }
  return { from, changes, sliders: [] };
}

/** изменение PID через слайдер Simplified (если режим не OFF) или напрямую по осям ролл/питч */
function pidChange(inp: AdvisorInput, slider: keyof SimplifiedPids, direct: 'P' | 'I' | 'D' | 'F', dir: 1 | -1, gains: PidGains): { from: Record<string, number>; changes: Record<string, number>; sliders: [string, number, number][] } {
  const sp = inp.simplified;
  const from: Record<string, number> = {};
  const changes: Record<string, number> = {};
  if (sp && sp.s.mode > 0) {
    const s0 = sp.s;
    const s1 = { ...s0, [slider]: stepSlider(s0[slider] as number, dir, 0) };
    const name = Object.keys(simplifiedToCli(s0, sp.dExtraName)).find((k) => simplifiedToCli(s0, sp.dExtraName)[k] !== simplifiedToCli(s1, sp.dExtraName)[k])!;
    const g0 = gainsToCli(gains);
    const g1 = gainsToCli(simplifiedPids(s1, inp.dKind, gains));
    from[name] = s0[slider] as number;
    changes[name] = s1[slider] as number;
    for (const k of Object.keys(g1)) if (g0[k] !== g1[k]) { from[k] = g0[k]; changes[k] = g1[k]; }
    return { from, changes, sliders: [[name, (s0[slider] as number) / 100, (s1[slider] as number) / 100]] };
  }
  const key = direct.toLowerCase();
  for (let a = 0; a < 2; a++) {
    const v = gains[direct][a];
    if (!isNum(v)) continue;
    const n = `${key}_${['roll', 'pitch'][a]}`;
    from[n] = v;
    changes[n] = clampParam(n, stepGain(v, dir));
  }
  return { from, changes, sliders: [] };
}

export function runAdvisor(inp: AdvisorInput, override: Partial<AdvisorCfg> = {}): AdvisorResult {
  A = { ...cfg.advisor, ...override };
  const c: Ctx = { inp, out: [] };
  const N = cfg.noise, M = cfg.motors, P = cfg.power;
  const nz = inp.noise;
  const fl = inp.filters;
  const pid = inp.pid;

  // ---------- лог ----------
  if (!inp.hasUnfilt) add(c, { id: 'R-LOG-NO-UNFILT-01', version: 1, kind: 'info', severity: 'yellow', inputs: {}, tab: 'filters', priority: 90 });
  if (inp.logHz < cfg.filters.minGoodLogHz) add(c, { id: 'R-LOG-RATE-01', version: 1, kind: 'info', severity: 'yellow', inputs: { logHz: Math.round(inp.logHz), need: cfg.filters.minGoodLogHz }, tab: 'filters', priority: 91 });

  // ---------- механика ----------
  const unfMax = nz ? maxOf(nz.unfilt) : -Infinity;
  const mechNoise = isNum(unfMax) && unfMax >= N.unfiltRms.red;
  if (mechNoise) add(c, { id: 'R-MECH-NOISE-01', version: 1, kind: 'mechanic', severity: 'red', inputs: { unfilt: +unfMax.toFixed(1), red: N.unfiltRms.red, axis: nz!.unfilt.indexOf(unfMax) }, tab: 'noise', priority: 1 });
  if (isNum(inp.motors.spreadPct) && inp.motors.spreadPct >= M.hoverSpreadPct.red) add(c, { id: 'R-MECH-SPREAD-01', version: 1, kind: 'mechanic', severity: 'red', inputs: { spread: +inp.motors.spreadPct.toFixed(1), red: M.hoverSpreadPct.red }, tab: 'motors', priority: 2 });
  // срывы в воздухе: десинк мотора или упор гироскопа без удара рядом — причину искать руками
  if (inp.motors.desyncs > 0 || inp.motors.airClips > 0) {
    add(c, { id: 'R-MECH-DESYNC-01', version: 1, kind: 'mechanic', severity: 'red', inputs: { desyncs: inp.motors.desyncs, clips: inp.motors.airClips, t: inp.motors.clipT.map((x) => x.toFixed(1)).join(', ') || '—' }, tab: 'flight', priority: 0 });
  }
  const satRed = inp.motors.satPct >= M.saturationPct.red;
  if (satRed) add(c, { id: 'R-AUTH-SAT-01', version: 1, kind: 'mechanic', severity: 'red', inputs: { sat: +inp.motors.satPct.toFixed(1), red: M.saturationPct.red }, tab: 'motors', priority: 3 });
  const s6 = inp.power.cells ? 6 / inp.power.cells : 1;
  const rOhm = inp.power.resistanceMOhm, rip = inp.power.rippleP99;
  if ((isNum(rOhm) && rOhm * s6 >= P.resistanceMOhm.red) || (isNum(rip) && rip * s6 >= P.rippleP99.red)) {
    add(c, { id: 'R-POWER-01', version: 1, kind: 'mechanic', severity: 'yellow', inputs: { r: isNum(rOhm) ? Math.round(rOhm) : '—', ripple: isNum(rip) ? +rip.toFixed(2) : '—' }, tab: 'motors', priority: 4 });
  }

  // ---------- фильтры ----------
  // усиливать фильтры можно и по редкому логу (D-term и шум меряются прямо из лога);
  // ослаблять — только когда модель фильтров совпадает с бортом (зелёная)
  const modelOk = !!fl && fl.reason !== 'mismatch' && fl.reason !== 'old-fw';
  const dMax = nz ? maxOf(nz.dterm.slice(0, 2)) : -Infinity;
  const fMax = nz ? maxOf(nz.filt) : -Infinity;
  if (fl && nz && modelOk) {
    const p = fl.params;
    if (isNum(dMax) && dMax >= A.dtermRms.red) {
      const ch = filterChange(p, 'dterm', -1);
      add(c, { id: 'R-FLT-DTERM-HOT-01', version: 1, kind: 'tune', severity: 'red', inputs: { dterm: +dMax.toFixed(1), red: A.dtermRms.red, axis: nz.dterm.indexOf(dMax) }, tab: 'filters', priority: 10, ...ch });
    }
    if (isNum(fMax) && fMax >= N.filtRms.red && !mechNoise) {
      const ch = filterChange(p, 'gyro', -1);
      add(c, { id: 'R-FLT-GYRO-NOISY-01', version: 1, kind: 'tune', severity: 'red', inputs: { filt: +fMax.toFixed(2), red: N.filtRms.red, axis: nz.filt.indexOf(fMax) }, tab: 'filters', priority: 11, ...ch });
    }
    const fullThr = !isNum(inp.flight?.thrTop) || inp.flight!.thrTop! >= A.fullThrottlePct;
    const clean = fullThr && fl.status === 'green' && isNum(fMax) && fMax < N.filtRms.green && (!isNum(unfMax) || unfMax < N.unfiltRms.green) && isNum(dMax) && dMax < A.dtermRms.green;
    if (clean && (p.simplified_gyro_filter_multiplier ?? 100) < 200) {
      const ch = filterChange(p, 'gyro', 1);
      add(c, { id: 'R-FLT-GYRO-RAISE-01', version: 1, kind: 'tune', severity: 'info', inputs: { filt: +fMax.toFixed(2), green: N.filtRms.green, dterm: +dMax.toFixed(1) }, tab: 'filters', priority: 40, safety: true, ...ch });
    }
    if (clean && (p.simplified_dterm_filter_multiplier ?? 100) < 200) {
      const ch = filterChange(p, 'dterm', 1);
      add(c, { id: 'R-FLT-DTERM-RAISE-01', version: 1, kind: 'tune', severity: 'info', inputs: { dterm: +dMax.toFixed(1), green: A.dtermRms.green }, tab: 'filters', priority: 41, safety: true, ...ch });
    }
    // резонанс рамы вне диапазона динамического нотча
    if ((p.dyn_notch_count ?? 0) > 0) {
      const lo = p.dyn_notch_min_hz ?? 0, hi = p.dyn_notch_max_hz ?? 0;
      const fr = nz.peaks.filter((x) => x.kind === 'frame' && x.prominenceDb >= A.framePeakMinDb && (x.hz < lo || x.hz > hi)).sort((a, b) => b.prominenceDb - a.prominenceDb)[0];
      if (fr) {
        const k = fr.hz < lo ? 'dyn_notch_min_hz' : 'dyn_notch_max_hz';
        const v = fr.hz < lo ? Math.floor((fr.hz * (1 - A.notchMarginPct / 100)) / 5) * 5 : Math.ceil((fr.hz * (1 + A.notchMarginPct / 100)) / 5) * 5;
        add(c, { id: 'R-DYN-NOTCH-RANGE-01', version: 1, kind: 'tune', severity: 'yellow', inputs: { hz: Math.round(fr.hz), db: Math.round(fr.prominenceDb), lo, hi, axis: fr.axis }, tab: 'noise', priority: 12, from: { [k]: p[k] }, changes: { [k]: clampParam(k, v) } });
      }
    }
  }

  // ---------- ориентиры чата Blackbox 2.0 (docs/knowledge/blackbox_two.md) ----------
  // лог без полного газа: шум на верхах не виден — ослаблять фильтры по нему нельзя
  const thrTop = inp.flight?.thrTop;
  if (isNum(thrTop) && thrTop < A.fullThrottlePct) add(c, { id: 'R-LOG-THROTTLE-01', version: 1, kind: 'info', severity: 'yellow', inputs: { top: Math.round(thrTop), need: A.fullThrottlePct }, tab: 'noise', priority: 92 });
  if (fl && nz && modelOk) {
    const p = fl.params;
    // фильтр гиро с срезом ниже полосы управления (5": 100 Гц): задержка → PID «регулирует прошлое»
    const lows = ['gyro_lpf1_static_hz', 'gyro_lpf1_dyn_min_hz', 'gyro_lpf2_static_hz'].filter((k) => isNum(p[k]) && p[k] > 0 && p[k] < A.minGyroCutoffHz);
    if (lows.length && !mechNoise && !(isNum(fMax) && fMax >= N.filtRms.red)) {
      const from: Record<string, number> = {}, changes: Record<string, number> = {};
      for (const k of lows) { from[k] = p[k]; changes[k] = clampParam(k, A.minGyroCutoffHz); }
      if (isNum(p.gyro_lpf1_dyn_max_hz) && p.gyro_lpf1_dyn_max_hz > 0 && changes.gyro_lpf1_dyn_min_hz && p.gyro_lpf1_dyn_max_hz < changes.gyro_lpf1_dyn_min_hz) { from.gyro_lpf1_dyn_max_hz = p.gyro_lpf1_dyn_max_hz; changes.gyro_lpf1_dyn_max_hz = clampParam('gyro_lpf1_dyn_max_hz', A.minGyroCutoffHz * 2); }
      add(c, { id: 'R-FLT-LOWCUT-01', version: 1, kind: 'tune', severity: 'yellow', inputs: { hz: Math.min(...lows.map((k) => p[k])), min: A.minGyroCutoffHz, cls: inp.board?.cls ?? '5in' }, tab: 'filters', priority: 13, safety: true, from, changes });
    }
    // задержка фильтров гиро выше ориентира для размера — только сведения: решать по шуму и моторам
    const gd = inp.flight?.gyroDelayMs;
    if (isNum(gd) && gd > A.gyroDelayTargetMs) add(c, { id: 'R-FLT-DELAY-01', version: 1, kind: 'info', severity: 'info', inputs: { ms: +gd.toFixed(2), target: A.gyroDelayTargetMs, cls: inp.board?.cls ?? '5in' }, tab: 'filters', priority: 60 });
  }

  // ---------- обязательные фильтры (чат Blackbox 2.0) ----------
  // Это усиление фильтров, а не ослабление: можно и по редкому логу, и без зелёной модели.
  if (fl) {
    const p = fl.params;
    const su = inp.setup;
    // PID-цикл медленнее гироскопа (pid_process_denom > 1): без LPF2 шум между частотами
    // гироскопа и PID «отражается» вниз при прореживании — LPF2 не отключать
    if (su && su.pidDenom > 1 && p.gyro_lpf2_static_hz === 0) {
      const v = p.simplified_gyro_filter ? applySimplified({ ...p, gyro_lpf2_static_hz: 1 }).gyro_lpf2_static_hz : 500;
      add(c, { id: 'R-FLT-LPF2-DENOM-01', version: 2, kind: 'tune', severity: 'yellow', inputs: { denom: su.pidDenom, hz: v }, tab: 'filters', priority: 9, from: { gyro_lpf2_static_hz: 0 }, changes: { gyro_lpf2_static_hz: clampParam('gyro_lpf2_static_hz', v) } });
    }
    // фильтры D-term выключены целиком: D отдаёт моторам весь шум
    // (срезы должны быть в заголовке: лог без настроек фильтров — не «всё выключено»)
    const dKnown = p.dterm_lpf1_static_hz !== undefined && p.dterm_lpf2_static_hz !== undefined;
    const dOff = dKnown && !(p.dterm_lpf1_static_hz ?? 0) && !(p.dterm_lpf1_dyn_min_hz ?? 0) && !(p.dterm_lpf2_static_hz ?? 0);
    if (dOff) {
      const v = p.simplified_dterm_filter ? applySimplified({ ...p, dterm_lpf1_static_hz: 1 }).dterm_lpf1_static_hz : 75;
      add(c, { id: 'R-FLT-DTERM-OFF-01', version: 2, kind: 'tune', severity: 'red', inputs: { hz: v }, tab: 'filters', priority: 8, from: { dterm_lpf1_static_hz: 0 }, changes: { dterm_lpf1_static_hz: clampParam('dterm_lpf1_static_hz', v) } });
    }
  }

  // ---------- настройка борта ----------
  // динамический холостой ход выключен при bidirectional DShot: стартовое значение по классу,
  // но ниже оборотов статического ХХ (иначе в конфигураторе «Dynamic Idle должен быть меньше Dshot Idle»)
  const su = inp.setup;
  // без bidirectional DShot нет RPM-фильтров — самый частый совет экспертов чата
  if (su && su.bidir === false) add(c, { id: 'R-SETUP-BIDIR-01', version: 1, kind: 'info', severity: 'yellow', inputs: {}, tab: 'motors', priority: 31 });
  // 1–2S: дин. ХХ в чате советуют не включать (рискованно для регуля) — поднимают статический ХХ
  if (su && su.bidir && su.dynIdle === 0 && !(inp.power.cells > 0 && inp.power.cells <= A.dynIdleMinCells - 1)) {
    let v = A.dynIdleRpm;
    let capped = false;
    if (isNum(su.idleRpm) && su.idleRpm > 0) {
      const cap = Math.floor((su.idleRpm * A.dynIdleIdleMargin) / 100);
      if (cap < v) { v = cap; capped = true; }
    }
    if (v >= 5) {
      add(c, { id: 'R-SETUP-DYN-IDLE-01', version: 2, kind: 'tune', severity: 'info', inputs: { v, rpm: v * 100, idle: isNum(su.idleRpm) ? Math.round(su.idleRpm) : '—', capped: capped ? 1 : 0, cls: inp.board?.cls ?? '5in' }, tab: 'motors', priority: 30, from: { dyn_idle_min_rpm: 0 }, changes: { dyn_idle_min_rpm: clampParam('dyn_idle_min_rpm', v) } });
    }
  }

  // ---------- PID ----------
  if (pid) {
    const rp = pid.axes.slice(0, 2);
    const untrusted = rp.filter((a) => !a.enough);
    if (untrusted.length) add(c, { id: 'R-STEP-DATA-01', version: 1, kind: 'flight', severity: 'yellow', inputs: { activeS: Math.round(Math.min(...rp.map((a) => a.step?.activeS ?? 0))), need: cfg.pid.minActiveS }, tab: 'pid', priority: 80 });
    const trusted = rp.filter((a) => a.enough && a.metrics);
    if (trusted.length && !satRed) {
      const g = pid.gains;
      const os = trusted.reduce((b, a) => (a.metrics!.overshootPct > b.metrics!.overshootPct ? a : b));
      const st = trusted.reduce((b, a) => (a.metrics!.settle < b.metrics!.settle ? a : b));
      const om = os.metrics!;
      if (om.overshootPct >= A.overshootHigh) {
        const dHot = isNum(dMax) && dMax >= A.dtermRms.green;
        if (!dHot && !mechNoise && !inp.board?.dSensitive) {
          add(c, { id: 'R-PID-OVERSHOOT-01', version: 1, kind: 'tune', severity: 'yellow', inputs: { os: +om.overshootPct.toFixed(0), high: A.overshootHigh, axis: os.axis, dterm: isNum(dMax) ? +dMax.toFixed(1) : '—', way: 'd' }, tab: 'pid', priority: 20, safety: true, ...pidChange(inp, 'd', 'D', 1, g) });
        } else {
          add(c, { id: 'R-PID-OVERSHOOT-01', version: 1, kind: 'tune', severity: 'yellow', inputs: { os: +om.overshootPct.toFixed(0), high: A.overshootHigh, axis: os.axis, dterm: isNum(dMax) ? +dMax.toFixed(1) : '—', way: 'p' }, tab: 'pid', priority: 20, ...pidChange(inp, 'pi', 'P', -1, g) });
        }
      } else if (om.overshootPct < A.overshootLow && isNum(om.delayMs) && om.delayMs > A.sluggishDelayMs) {
        add(c, { id: 'R-PID-SLUGGISH-01', version: 1, kind: 'tune', severity: 'yellow', inputs: { os: +om.overshootPct.toFixed(1), delay: +om.delayMs.toFixed(0), slow: A.sluggishDelayMs, axis: os.axis }, tab: 'pid', priority: 21, ...pidChange(inp, 'ff', 'F', 1, g) });
      }
      if (st.metrics!.settle < A.settleLow) {
        add(c, { id: 'R-PID-SAG-01', version: 1, kind: 'tune', severity: 'yellow', inputs: { settle: +st.metrics!.settle.toFixed(2), low: A.settleLow, axis: st.axis }, tab: 'pid', priority: 22, ...pidChange(inp, 'i', 'I', 1, g) });
      }
    }
  }

  // ---------- запасы устойчивости (C) ----------
  // мал запас по фазе — P/D не поднимаем (это ближе к раскачке), сначала задержка фильтров;
  // мал запас по амплитуде — P/I на шаг ниже. Только по запасам, которым можно верить.
  const SB = cfg.chirp;
  const stab = (inp.stability ?? []).filter((x) => x.axis < 2);
  const pmLow = stab.filter((x) => isNum(x.pmDeg) && x.pmDeg < SB.pm.green).sort((a, b) => a.pmDeg! - b.pmDeg!)[0];
  const gmLow = stab.filter((x) => isNum(x.gmDb) && x.gmDb < SB.gm.red).sort((a, b) => a.gmDb! - b.gmDb!)[0];
  const stabilityBlock = !!pmLow || !!gmLow;
  if (pmLow) add(c, { id: 'R-STAB-PM-LOW-01', version: 1, kind: 'info', severity: pmLow.pmDeg! < SB.pm.red ? 'red' : 'yellow', inputs: { axis: pmLow.axis, pm: Math.round(pmLow.pmDeg!), green: SB.pm.green, red: SB.pm.red, hz: Math.round(pmLow.crossHz), src: pmLow.source }, tab: 'filters', priority: 5 });
  if (gmLow && pid) add(c, { id: 'R-STAB-GM-LOW-01', version: 1, kind: 'tune', severity: 'red', inputs: { axis: gmLow.axis, gm: +gmLow.gmDb!.toFixed(1), red: SB.gm.red, src: gmLow.source }, tab: 'pid', priority: 6, ...pidChange(inp, 'pi', 'P', -1, pid.gains) });

  // ---------- тест моторов на столе ----------
  // моторы крутили из конфигуратора без пропов: тяга, разброс, питание, PID и настройки по такому
  // логу не оцениваются (в чате на такие логи смотрят только шум гиро по моторам)
  if (inp.flight?.bench) {
    const keep = new Set(['R-MECH-NOISE-01', 'R-LOG-NO-UNFILT-01', 'R-LOG-RATE-01', 'R-SETUP-BIDIR-01']);
    c.out = c.out.filter((a) => keep.has(a.id));
    add(c, { id: 'R-LOG-BENCH-01', version: 1, kind: 'info', severity: 'yellow', inputs: {}, tab: 'noise', priority: -1 });
  }

  // ---------- знание о борте: отключённые правила, правила «с осторожностью» ----------
  const off = new Set([...(A.disabledRules ?? []), ...(inp.board?.disabledRules ?? [])]);
  c.out = c.out.filter((a) => !off.has(a.id));
  for (const a of c.out) {
    const cs = inp.board?.caution?.[a.id];
    if (cs) a.caution = cs;
  }
  // автотюн: свои правила R-AT-* и что в этот полёт не трогаем («не душить», пропы, откат)
  autotunePolicy(c.out, inp, (a) => add(c, a));
  const maxChanges = inp.board?.autotune ? cfg.autotune.maxChanges : A.maxChanges;

  // ---------- выбор на эту итерацию ----------
  const mech = c.out.some((a) => a.kind === 'mechanic' && a.severity === 'red');
  const used = new Set<string>();
  let n = 0, nSafety = 0;
  for (const a of c.out.sort((x, y) => x.priority - y.priority)) {
    // параметр, которого нет в этой версии прошивки, не советуем
    for (const k of Object.keys(a.changes)) if (!paramAvailable(k, inp.fwCode)) { delete a.changes[k]; delete a.from[k]; }
    if (a.kind !== 'tune') { a.selected = true; continue; }
    if (a.deferred) continue;
    // откат к настройкам, на которых уже летали, — не ждёт механику и не боится «осторожности»
    const revert = a.id === 'R-AT-REVERT-01';
    if (mech && !revert) { a.deferred = 'mechanics-first'; continue; }
    if (a.caution && !revert) { a.deferred = 'caution'; continue; }
    if (stabilityBlock && raisesPD(a) && !revert) { a.deferred = 'stability'; continue; }
    if (Object.keys(a.changes).some((k) => used.has(k))) { a.deferred = 'same-param'; continue; }
    if (n >= maxChanges) { a.deferred = 'max-changes'; continue; }
    if (a.safety && nSafety >= A.maxSafetyChanges) { a.deferred = 'one-risky'; continue; }
    if (!Object.keys(a.changes).length) continue;
    a.selected = true;
    n++;
    if (a.safety) nSafety++;
    Object.keys(a.changes).forEach((k) => used.add(k));
  }
  const from: Record<string, number> = {}, to: Record<string, number> = {};
  for (const a of c.out) if (a.selected && a.kind === 'tune') { Object.assign(from, a.from); Object.assign(to, a.changes); }
  return { advice: c.out, from, to, autotune: autotuneSummary(c.out, inp) };
}

/** совет поднимает P или D (напрямую или слайдером Simplified) */
function raisesPD(a: Advice): boolean {
  return Object.entries(a.changes).some(([k, v]) => /^(p|d)_(roll|pitch|yaw)$|^d_(max|min)_|^simplified_(master_multiplier|d_gain|pi_gain|d_max_gain|dmax_gain)$/.test(k) && v > (a.from[k] ?? v));
}

/** вход советчика из результатов анализа (общий для воркера и тестов) */
export function advisorInputFrom(
  c: { fw: { code: number }; fs: number; hasGyroUnfilt: boolean; cells: number; log: { header: Record<string, string> } },
  nz: { axes: { axis: number; rmsUnfilt: number | null; rmsFilt: number; rmsDterm: number | null; peaks: { kind: string; hz: number; prominenceDb: number }[] }[] },
  h: { motors: { satPct: number; spreadPct: number | null; desyncs: number; idleRpm?: number | null }; power: { resistanceMOhm: number | null; rippleP99: number | null }; anomalies: { kind: string; t0: number }[] },
  filters: { params: FilterParams; status: string; reason: string } | null,
  pid: PidResult | null,
  simplified: AdvisorInput['simplified'],
): AdvisorInput {
  return {
    fwCode: c.fw.code,
    logHz: c.fs,
    hasUnfilt: c.hasGyroUnfilt,
    noise: {
      unfilt: nz.axes.map((a) => a.rmsUnfilt),
      filt: nz.axes.map((a) => a.rmsFilt),
      dterm: nz.axes.map((a) => a.rmsDterm),
      peaks: nz.axes.flatMap((a) => a.peaks.map((p) => ({ axis: a.axis, kind: p.kind, hz: p.hz, prominenceDb: p.prominenceDb }))),
    },
    filters,
    pid,
    simplified,
    dKind: c.log.header.d_max !== undefined ? 'd_max' : 'd_min',
    motors: { satPct: h.motors.satPct, spreadPct: h.motors.spreadPct, desyncs: h.motors.desyncs, ...airClips(h.anomalies) },
    power: { resistanceMOhm: h.power.resistanceMOhm, rippleP99: h.power.rippleP99, cells: c.cells },
    setup: setupFromHeader(c.log.header, h.motors.idleRpm ?? null),
  };
}

/** настройка борта из заголовка лога (имена заголовка совпадают с CLI) */
export function setupFromHeader(H: Record<string, string>, idleRpm: number | null): AdvisorInput['setup'] {
  const num = (k: string): number | null => {
    const v = H[k];
    if (v === undefined || v === '') return null;
    const x = Number(v.split(',')[0]);
    return Number.isFinite(x) ? x : null;
  };
  const bd = num('dshot_bidir');
  return { dynIdle: num('dyn_idle_min_rpm'), bidir: bd === null ? null : bd === 1, pidDenom: num('pid_process_denom') ?? 1, idleRpm };
}

/** упоры гироскопа не дальше clipNearImpactS от удара — это краш, а не срыв в воздухе */
function airClips(an: { kind: string; t0: number }[]): { airClips: number; clipT: number[] } {
  const impacts = an.filter((a) => a.kind === 'IMPACT').map((a) => a.t0);
  const clipT = an.filter((a) => a.kind === 'GYRO_CLIP' && !impacts.some((t) => Math.abs(t - a.t0) <= A.clipNearImpactS)).map((a) => a.t0);
  return { airClips: clipT.length, clipT };
}
