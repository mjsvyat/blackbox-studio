// Chirp-идентификация по логу (C). Сверено с BF 2026.6.1 (ссылки — docs/dev/PLAN.md, раздел C):
//  - режим CHIRP (бокс CHIRP, флаг в flightModeFlags — номер по таблице версии), при каждом
//    включении — следующая ось (ролл → питч → яв); генератор common/chirp.c: экспоненциальный
//    chirp chirp_frequency_start_deci_hz → _end_deci_hz за chirp_time_seconds, амплитуда
//    chirp_amplitude_<ось> °/с, через фазовый корректор (chirp_lag/lead_freq_hz);
//  - возбуждение прибавляется к setpoint ДО записи в лог (pid.c: currentPidSetpoint += chirp,
//    previousPidSetpoint — «значение для блэкбокса»), так что записанный setpoint его содержит;
//  - debug_mode = CHIRP (96 в 2026.6, 97 в 2025.12): debug[1] — активная ось (−1 — нет),
//    debug[2] — частота ×10;
//  - в сборке режим есть только с USE_CHIRP (в target/ и mk/ 2026.6.1 он нигде не включён —
//    пользовательский define); в заголовке лога строки chirp_* — признак, что режим собран.
// Нет chirp — те же характеристики по обычному полёту: где стики возбуждали систему,
// когерентность высокая, остальное честно бледное.

import cfg from '../config/analysis.json';
import { col } from '../decoder/decoder';
import { bitNames, flightModeNames } from '../decoder/constants';
import { nextPow2 } from '../dsp/fft';
import type { LogContext } from '../analysis/context';
import { nonRateMask } from '../rates/analyze';
import { AxisModel, CtrlModel, Gains, PlantModel, decimate, fitCtrl, stepSim } from './axisModel';
import { stepMetrics } from '../pid/stepResponse';
import { Frf, Margins, bandwidthHz, cmul, ctrlLoopFrf, fitPlantToFrf, margins, unwrapDeg, welchFrf } from './frf';

const C = cfg.chirp;

export const CHIRP_PARAMS = ['chirp_lag_freq_hz', 'chirp_lead_freq_hz', 'chirp_amplitude_roll', 'chirp_amplitude_pitch', 'chirp_amplitude_yaw', 'chirp_frequency_start_deci_hz', 'chirp_frequency_end_deci_hz', 'chirp_time_seconds'] as const;

/** номер DEBUG_CHIRP в build/debug.h по версии (null — режима нет) */
export function debugChirpIndex(fwCode: number): number | null {
  if (fwCode >= 2_026_006_000) return 96;
  if (fwCode >= 2_025_012_000) return 97;
  return null;
}

export interface ChirpFirmware {
  /** режим собран в прошивке (в заголовке есть chirp_*) */
  inFirmware: boolean;
  params: Record<string, number> | null;
  /** лог пишет debug-каналы CHIRP */
  debugChirp: boolean;
}

export function chirpFirmware(H: Record<string, string>, fwCode: number): ChirpFirmware {
  const has = CHIRP_PARAMS.every((k) => H[k] !== undefined);
  const params = has ? Object.fromEntries(CHIRP_PARAMS.map((k) => [k, Number(H[k])])) : null;
  const di = debugChirpIndex(fwCode);
  return { inFirmware: has, params, debugChirp: di !== null && Number(H.debug_mode) === di };
}

export interface ChirpSeg {
  axis: number;
  i0: number;
  i1: number;
  seconds: number;
  /** как узнали ось: debug-канал или по setpoint */
  axisFrom: 'debug' | 'setpoint';
}

/** участки с включённым CHIRP и их оси */
export function chirpSegments(c: LogContext, fwInfo: ChirpFirmware): ChirpSeg[] {
  const { log, n, tSec } = c;
  const S = log.slowFieldNames;
  const iMode = S.indexOf('flightModeFlags');
  const on = new Uint8Array(n);
  if (iMode >= 0 && log.slow.length) {
    const names = flightModeNames(c.fw.code);
    const t0 = log.time[0];
    let i = 0;
    for (let k = 0; k < log.slow.length; k++) {
      const r = log.slow[k];
      const a = (r.t - t0) / 1e6;
      const b = k + 1 < log.slow.length ? (log.slow[k + 1].t - t0) / 1e6 : Infinity;
      if (!bitNames(r.v[iMode], names).includes('CHIRP')) continue;
      while (i < n && tSec[i] < a) i++;
      for (let j = i; j < n && tSec[j] < b; j++) on[j] = 1;
    }
  }
  const dbgAxis = fwInfo.debugChirp ? col(log, 'debug[1]') : null;
  const sp = [0, 1, 2].map((a) => col(log, `setpoint[${a}]`));
  const out: ChirpSeg[] = [];
  for (let i = 0; i < n; ) {
    if (!on[i]) { i++; continue; }
    let j = i;
    while (j < n && on[j]) j++;
    let axis = -1;
    let from: ChirpSeg['axisFrom'] = 'setpoint';
    if (dbgAxis) {
      const cnt = [0, 0, 0];
      for (let k = i; k < j; k++) if (dbgAxis[k] >= 0 && dbgAxis[k] <= 2) cnt[dbgAxis[k]]++;
      if (Math.max(...cnt) > 0) { axis = cnt.indexOf(Math.max(...cnt)); from = 'debug'; }
    }
    if (axis < 0) {
      // ось с самым «дёрганым» setpoint (разности — высокие частоты chirp)
      const e = sp.map((s) => { let v = 0; if (s) for (let k = i + 1; k < j; k++) v += (s[k] - s[k - 1]) ** 2; return v; });
      axis = e.indexOf(Math.max(...e));
    }
    out.push({ axis, i0: i, i1: j, seconds: (j - i) / c.fs, axisFrom: from });
    i = j;
  }
  return out;
}

export interface AxisFrf {
  axis: number;
  source: 'chirp' | 'flight';
  seconds: number;
  /** замкнутый контур setpoint → gyro */
  T: Frf;
  /** объект: команда PID → gyro, косвенно через setpoint (null — нет axisP/I/D/F в логе) */
  P: Frf | null;
  /** разомкнутый контур L = P_изм · регулятор (те же частоты, что у P) */
  L: { re: number[]; im: number[] } | null;
  margins: Margins | null;
  /** когерентность у частоты среза — запасам можно верить, если ≥ marginCoh */
  cohAtCross: number | null;
  marginsOk: boolean;
  bwHz: number | null;
}

export interface ChirpModelCmp {
  axis: number;
  /** совпадение модели с измеренным: chirp — по АЧХ/ФЧХ, фристайл — по step response, % */
  chirpFit: number;
  flightFit: number | null;
  /** полная ширина полосы прогноза перерегулирования для D ×1.2, п.п. (без минимальной ширины) */
  chirpBandPp: number;
  flightBandPp: number | null;
}

export interface ChirpResult {
  fw: ChirpFirmware;
  segments: ChirpSeg[];
  axes: AxisFrf[];
  /** модели осей по chirp (для прогноза PID вместо модели по step response) */
  models: AxisModel[];
  /** сравнение с моделью по обычному полёту (заполняет конвейер) */
  cmp: ChirpModelCmp[];
}

function interpCoh(m: Frf, hz: number): number | null {
  for (let i = 1; i < m.f.length; i++) if (m.f[i] >= hz) {
    const a = (hz - m.f[i - 1]) / (m.f[i] - m.f[i - 1]);
    return m.coh[i - 1] + a * (m.coh[i] - m.coh[i - 1]);
  }
  return null;
}

/** пригодные кадры обычного полёта (как для модели оси): полёт, акро, без упора моторов */
function flightUse(c: LogContext, flightMask: Uint8Array): Uint8Array {
  const nr = nonRateMask(c).mask;
  const sat = cfg.motors.saturationNorm;
  const use = new Uint8Array(c.n);
  for (let i = 0; i < c.n; i++) use[i] = flightMask[i] && !nr[i] && !c.motorNorm.some((m) => m[i] >= sat) ? 1 : 0;
  return use;
}

export function analyzeChirp(c: LogContext, flightMask: Uint8Array): ChirpResult {
  const fw = chirpFirmware(c.log.header, c.fw.code);
  const segments = chirpSegments(c, fw);
  const nfft = nextPow2(c.fs * C.windowS);
  const fUse = flightUse(c, flightMask);
  const axes: AxisFrf[] = [];
  const models: AxisModel[] = [];
  for (let ax = 0; ax < 3; ax++) {
    const sp = col(c.log, `setpoint[${ax}]`), gy = col(c.log, `gyroADC[${ax}]`);
    if (!sp || !gy) continue;
    const segs = segments.filter((s) => s.axis === ax);
    const chirpS = segs.reduce((a, s) => a + s.seconds, 0);
    const source: AxisFrf['source'] = chirpS >= C.minChirpS ? 'chirp' : 'flight';
    const use = new Uint8Array(c.n);
    if (source === 'chirp') for (const s of segs) use.fill(1, s.i0, s.i1);
    else use.set(fUse);
    const T = welchFrf(sp, gy, use, c.fs, nfft);
    if (!T.segments) continue;
    // команда PID — сумма записанных P + I + D + F
    const parts = ['axisP', 'axisI', 'axisD', 'axisF'].map((k) => col(c.log, `${k}[${ax}]`));
    let P: Frf | null = null, L: AxisFrf['L'] = null, mg: Margins | null = null, cohAtCross: number | null = null;
    let ctrl: CtrlModel | null = null;
    if (parts[0] && parts[1] && parts[2]) {
      const u = new Float32Array(c.n);
      for (let i = 0; i < c.n; i++) u[i] = parts[0]![i] + parts[1]![i] + parts[2]![i] + (parts[3] ? parts[3][i] : 0);
      // объект — косвенно, через внешний вход setpoint: P = (gyro/setpoint) / (команда/setpoint).
      // Прямая оценка «команда → gyro» в замкнутом контуре смещена: возмущения через обратную
      // связь попадают и в команду (на 4.5.2 №3 давала запас по фазе 14° при перерегулировании 5 %)
      const U = welchFrf(sp, u, use, c.fs, nfft);
      P = { f: T.f, re: [], im: [], coh: [], segments: T.segments };
      for (let i = 0; i < T.f.length; i++) {
        const d = U.re[i] ** 2 + U.im[i] ** 2;
        P.re.push(d ? (T.re[i] * U.re[i] + T.im[i] * U.im[i]) / d : NaN);
        P.im.push(d ? (T.im[i] * U.re[i] - T.re[i] * U.im[i]) / d : NaN);
        P.coh.push(Math.min(T.coh[i], U.coh[i]));
      }
      // регулятор — на частоте лога (после прореживания D и F подбираются со смещением)
      // для обычного полёта хватает 1 кГц (высоких частот там почти нет), длинные логи — быстрее
      const ctrlHz = source === 'chirp' ? c.fs : Math.min(c.fs, 1000);
      ctrl = fitCtrl(decimate({ sp, gy, P: parts[0], I: parts[1], D: parts[2], F: parts[3] }, use, c.fs, ctrlHz));
      ctrl = { ...ctrl, lead: Math.round((ctrl.lead * c.fs) / ctrlHz) };
      const K = ctrlLoopFrf(ctrl, P.f, c.fs);
      const Lc = P.f.map((_, i) => cmul([P!.re[i], P!.im[i]], K[i]));
      L = { re: Lc.map((v) => v[0]), im: Lc.map((v) => v[1]) };
      // запасы — только где объект измерен уверенно (пересечение между соседними такими точками)
      mg = margins(P.f, Lc, (i) => P!.coh[i] >= C.minCoh);
      if (mg.crossHz === null) mg = null;
      cohAtCross = mg?.crossHz ? interpCoh(P, mg.crossHz) : null;
    }
    const Tc = T.f.map((_, i): [number, number] => [T.re[i], T.im[i]]);
    const bwHz = bandwidthHz(T.f, Tc, (i) => T.coh[i] >= C.minCoh);
    axes.push({ axis: ax, source, seconds: source === 'chirp' ? chirpS : fUse.reduce((a, v) => a + v, 0) / c.fs, T, P, L, margins: mg, cohAtCross, marginsOk: !!mg?.crossHz && (cohAtCross ?? 0) >= C.marginCoh, bwHz });

    // модель оси по chirp: объект по АЧХ/ФЧХ замкнутого контура
    if (source === 'chirp' && ctrl && ctrl.kp > 0 && ctrl.pFit >= cfg.sysid.minCtrlFit) {
      const x = decimate({ sp, gy, P: parts[0], I: parts[1], D: parts[2], F: parts[3] }, use, c.fs, cfg.sysid.decimHz);
      const ctrlM: CtrlModel = { ...ctrl, lead: Math.round((ctrl.lead * x.fs) / c.fs) };
      const nM = nextPow2(x.fs * C.windowS * 2);
      const o = { minCoh: C.minCoh, fMin: C.fitFMin, fMax: C.fitFMax };
      const cand = { tauMs: cfg.sysid.motorTauMs, maxDelayMs: cfg.sysid.maxDelayMs, delayStep: cfg.sysid.delayStep, iters: cfg.sysid.gainIters };
      const meas = welchFrf(x.sp, x.gy, x.use, x.fs, nM);
      const r = fitPlantToFrf(meas, ctrlM, x.fs, o, cand);
      if (r) {
        // полоса: окна Уэлча через одно → C.parts групп, у каждой своё усиление при тех же τ и d
        const partsP: PlantModel[] = [];
        for (let g = 0; g < C.parts; g++) {
          const mp = welchFrf(x.sp, x.gy, x.use, x.fs, nM, x.fs / 2, (k) => k % C.parts === g);
          const pr = mp.segments ? fitPlantToFrf(mp, ctrlM, x.fs, o, cand, { a: r.plant.a, d: r.plant.d }) : null;
          if (pr) partsP.push(pr.plant);
        }
        const ok = r.fit >= cfg.sysid.minStepFit;
        models.push({ axis: ax, fs: x.fs, plant: r.plant, ctrl: ctrlM, stepFit: r.fit, parts: partsP, ok, why: ok ? 'ok' : 'bad-fit' });
      }
    }
  }
  return { fw, segments, axes, models, cmp: [] };
}

/** полная ширина разброса перерегулирования по частям модели для изменения g, п.п. (без минимума) */
export function rawBandPp(m: AxisModel, g: Gains, R: number): number {
  const os = (p: PlantModel): number => {
    const y = stepSim(p, m.ctrl, g, R, m.fs);
    return stepMetrics({ t: Float32Array.from({ length: R }, (_, i) => i / m.fs), mean: Float32Array.from(y) }).overshootPct;
  };
  const v = [m.plant, ...m.parts].map(os).filter(Number.isFinite);
  return v.length > 1 ? Math.max(...v) - Math.min(...v) : NaN;
}

/** сравнение моделей «по фристайлу» (step response) и «по chirp» на одной оси */
export function compareModels(flight: AxisModel | null, chirp: AxisModel): ChirpModelCmp {
  const g: Gains = { p: 1, i: 1, d: 1.2, f: 1 };
  const R = Math.round(cfg.pid.respS * chirp.fs);
  return {
    axis: chirp.axis,
    chirpFit: chirp.stepFit,
    flightFit: flight?.ok ? flight.stepFit : null,
    chirpBandPp: rawBandPp(chirp, g, R),
    flightBandPp: flight?.ok ? rawBandPp(flight, g, Math.round(cfg.pid.respS * flight.fs)) : null,
  };
}

/** для интерфейса: дБ / градусы / когерентность по частотам, без комплексных массивов */
export interface FreqView {
  fw: ChirpFirmware;
  segments: { axis: number; t0: number; t1: number; seconds: number; axisFrom: ChirpSeg['axisFrom'] }[];
  axes: {
    axis: number;
    source: AxisFrf['source'];
    seconds: number;
    f: number[];
    tDb: number[];
    tPh: number[];
    tCoh: number[];
    pDb: number[] | null;
    pPh: number[] | null;
    lDb: number[] | null;
    lPh: number[] | null;
    margins: Margins | null;
    cohAtCross: number | null;
    marginsOk: boolean;
    bwHz: number | null;
  }[];
  cmp: ChirpModelCmp[];
}

const toDbAbs = (re: number, im: number): number => 20 * Math.log10(Math.max(1e-9, Math.hypot(re, im)));

export function freqView(r: ChirpResult, tSec: ArrayLike<number>): FreqView {
  // кривые — только там, где когерентность ≥ minCoh (остальное — разрывы): измерению вне этих
  // частот верить нельзя, а фаза, развёрнутая через шум, уходит на тысячи градусов
  const masked = (re: number[], im: number[], coh: number[]): { db: number[]; ph: number[] } => {
    const idx = coh.map((c, i) => (c >= C.minCoh && Number.isFinite(re[i]) ? i : -1)).filter((i) => i >= 0);
    const ph = unwrapDeg(idx.map((i): [number, number] => [re[i], im[i]]));
    const db = re.map(() => NaN), pa = re.map(() => NaN);
    idx.forEach((i, j) => { db[i] = toDbAbs(re[i], im[i]); pa[i] = ph[j]; });
    return { db, ph: pa };
  };
  return {
    fw: r.fw,
    segments: r.segments.map((s) => ({ axis: s.axis, t0: tSec[s.i0], t1: tSec[Math.max(s.i0, s.i1 - 1)], seconds: s.seconds, axisFrom: s.axisFrom })),
    axes: r.axes.map((a) => {
      const t = masked(a.T.re, a.T.im, a.T.coh);
      const p = a.P ? masked(a.P.re, a.P.im, a.P.coh) : null;
      const l = a.L && a.P ? masked(a.L.re, a.L.im, a.P.coh) : null;
      return {
        axis: a.axis, source: a.source, seconds: a.seconds, f: a.T.f,
        tDb: t.db, tPh: t.ph, tCoh: a.T.coh,
        pDb: p?.db ?? null, pPh: p?.ph ?? null, lDb: l?.db ?? null, lPh: l?.ph ?? null,
        margins: a.margins, cohAtCross: a.cohAtCross, marginsOk: a.marginsOk, bwHz: a.bwHz,
      };
    }),
    cmp: r.cmp,
  };
}
