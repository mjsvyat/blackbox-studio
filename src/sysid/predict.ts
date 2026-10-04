// Прогноз PID по модели оси (sysid/axisModel.ts): кривая step response с полосой и метрики
// с диапазоном. Прогноз — не факт: на графике пунктир + полоса + подпись «модель, проверь
// полётом»; при плохой модели не выдаётся.

import cfg from '../config/analysis.json';
import { col } from '../decoder/decoder';
import type { LogContext } from '../analysis/context';
import type { PidResult } from '../pid/analyze';
import type { PidGains } from '../pid/gains';
import { stepMetrics } from '../pid/stepResponse';
import { nonRateMask } from '../rates/analyze';
import { AxisModel, Gains, SAME, decimate, identifyAxis, stepSim } from './axisModel';

const C = cfg.sysid;

export interface Sysid {
  axes: AxisModel[];
  /** время кривых, с (как у измеренной) */
  t: number[];
}

export function identify(c: LogContext, flightMask: Uint8Array, pid: PidResult): Sysid {
  const nr = nonRateMask(c).mask;
  const sat = cfg.motors.saturationNorm;
  const use = new Uint8Array(c.n);
  for (let i = 0; i < c.n; i++) use[i] = flightMask[i] && !nr[i] && !c.motorNorm.some((m) => m[i] >= sat) ? 1 : 0;
  const axes = [0, 1, 2].map((ax) => {
    const sp = col(c.log, `setpoint[${ax}]`), gy = col(c.log, `gyroADC[${ax}]`);
    const pa = pid.axes[ax];
    const x = decimate({ sp: sp!, gy: gy!, P: col(c.log, `axisP[${ax}]`), I: col(c.log, `axisI[${ax}]`), D: col(c.log, `axisD[${ax}]`), F: col(c.log, `axisF[${ax}]`) }, use, c.fs, C.decimHz);
    return identifyAxis(ax, x, { mean: pa.step?.mean ?? [], parts: pa.step?.parts ?? [], enough: !!pa.step && pa.enough });
  });
  const t = pid.axes.find((a) => a.step)?.step?.t;
  return { axes, t: t ? Array.from(t) : [] };
}

export interface Range { mid: number; lo: number; hi: number }

export interface AxisForecast {
  axis: number;
  ok: boolean;
  why: AxisModel['why'];
  stepFit: number;
  /** модель на текущих коэффициентах (для сравнения с измеренной) */
  now: number[];
  /** прогноз: середина и полоса */
  mid: number[];
  lo: number[];
  hi: number[];
  overshoot: Range;
  delayMs: Range;
  settle: Range;
  /** те же метрики модели на текущих коэффициентах */
  nowMetrics: { overshoot: number; delayMs: number; settle: number };
}

/** множители к текущим коэффициентам по осям из новых PID (и изменения задержек фильтров) */
export function gainsRatio(cur: PidGains, next: PidGains, delays?: { dGyroMs: number; dDtermMs: number }): Gains[] {
  const r = (a: number, b: number): number => (Number.isFinite(a) && a > 0 && Number.isFinite(b) ? b / a : 1);
  return [0, 1, 2].map((ax) => ({ p: r(cur.P[ax], next.P[ax]), i: r(cur.I[ax], next.I[ax]), d: r(cur.D[ax], next.D[ax]), f: r(cur.F[ax], next.F[ax]), ...(delays ?? {}) }));
}

/** прогноз по оси; bandScale — калибровка полосы по истории борта (≥ 1) */
export function forecastAxis(m: AxisModel, g: Gains, t: number[], bandScale = 1): AxisForecast {
  const R = t.length;
  const tf = Float32Array.from(t);
  const met = (s: ArrayLike<number>): { overshoot: number; delayMs: number; settle: number } => {
    const k = stepMetrics({ t: tf, mean: Float32Array.from(s) });
    return { overshoot: k.overshootPct, delayMs: k.delayMs, settle: k.settle };
  };
  const empty: Range = { mid: NaN, lo: NaN, hi: NaN };
  if (!m.ok || !R) return { axis: m.axis, ok: false, why: m.why, stepFit: m.stepFit, now: [], mid: [], lo: [], hi: [], overshoot: empty, delayMs: empty, settle: empty, nowMetrics: { overshoot: NaN, delayMs: NaN, settle: NaN } };
  const now = Array.from(stepSim(m.plant, m.ctrl, SAME, R, m.fs));
  const mid = Array.from(stepSim(m.plant, m.ctrl, g, R, m.fs));
  const parts = m.parts.map((p) => Array.from(stepSim(p, m.ctrl, g, R, m.fs)));
  // полоса: разброс кривых по частям полёта, расширенный калибровкой
  const lo = mid.map((v, i) => Math.min(v, ...parts.map((p) => v + (p[i] - v) * bandScale)));
  const hi = mid.map((v, i) => Math.max(v, ...parts.map((p) => v + (p[i] - v) * bandScale)));
  const mm = met(mid);
  const pm = parts.map(met);
  const range = (k: 'overshoot' | 'delayMs' | 'settle', minHalf: number): Range => {
    const v = mm[k];
    const d = pm.map((x) => (x[k] - v) * bandScale).filter(Number.isFinite);
    const lo2 = Math.min(v - minHalf, v + Math.min(0, ...d)), hi2 = Math.max(v + minHalf, v + Math.max(0, ...d));
    return { mid: v, lo: k === 'overshoot' ? Math.max(0, lo2) : lo2, hi: hi2 };
  };
  return {
    axis: m.axis, ok: true, why: m.why, stepFit: m.stepFit, now, mid, lo, hi,
    overshoot: range('overshoot', C.bandMinPp), delayMs: range('delayMs', C.bandMinMs), settle: range('settle', C.bandMinSettle),
    nowMetrics: met(now),
  };
}
