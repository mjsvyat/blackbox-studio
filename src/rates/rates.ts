// Рейты Betaflight: формулы стик → °/с для всех rates_type — один в один с
// src/main/fc/rc.c (BF 4.3 … 2026.6, формулы с 4.3 не менялись):
//   applyBetaflightRates / applyRaceFlightRates / applyKissRates /
//   applyActualRates / applyQuickRates, затем calculateSetpointRate:
//   rcCommandf = rcCommand / (500 − deadband)  (для yaw — yaw_deadband),
//   setpoint = constrain(applyRates(rcCommandf, |rcCommandf|), ±rate_limit).
// После этого прошивка сглаживает setpoint фильтром RC smoothing (PT3, см. setpoint.ts).
// Хранимые значения (rc_rates, rates, rc_expo) — целые, как в CLI и заголовке лога.

import { nums } from '../decoder/header';

export const RATES_TYPE = { BETAFLIGHT: 0, RACEFLIGHT: 1, KISS: 2, ACTUAL: 3, QUICK: 4 } as const;
/** имена в CLI (lookupTableRatesType) */
export const RATES_TYPE_NAMES = ['BETAFLIGHT', 'RACEFLIGHT', 'KISS', 'ACTUAL', 'QUICK'];

/** SETPOINT_RATE_LIMIT и границы rate_limit (CONTROL_RATE_CONFIG_RATE_LIMIT_MIN/MAX) */
export const SETPOINT_RATE_LIMIT = 1998;
export const RATE_LIMIT_MIN = 200;
const RC_RATE_INCREMENTAL = 14.54;

export interface AxisRates {
  /** rc_rates[axis]: BF/KISS — RC Rate ×100; Actual — центр. чувствительность /10; Quick — RC Rate ×100; Raceflight — °/с /10 */
  rcRate: number;
  /** rates[axis]: BF/KISS — Super Rate ×100; Actual/Quick — макс. °/с /10; Raceflight — Acro+ % */
  rate: number;
  /** rc_expo[axis], 0…100 */
  expo: number;
  /** rate_limits[axis], °/с */
  limit: number;
}

export interface RateProfile {
  type: number;
  axes: AxisRates[];
  /** quickrates_rc_expo (в заголовке не пишется — по умолчанию 0) */
  quickRcExpo: number;
  deadband: number;
  yawDeadband: number;
}

const constrain = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const p3 = (x: number): number => x * x * x;
const p5 = (x: number): number => x * x * x * x * x;

/** setpoint (°/с) для отклонения стика d ∈ [−1, 1] по формуле своего типа, до rate_limit */
export function applyRates(type: number, a: AxisRates, d: number, quickRcExpo = 0): number {
  const abs = Math.abs(d);
  switch (type) {
    case RATES_TYPE.RACEFLIGHT: {
      const c = (1 + 0.01 * a.expo * (d * d - 1)) * d;
      const r = 10 * a.rcRate * c;
      return r * (1 + abs * a.rate * 0.01);
    }
    case RATES_TYPE.KISS: {
      const curve = a.expo / 100;
      const use = 1 / constrain(1 - abs * (a.rate / 100), 0.01, 1);
      const cmd = (p3(d) * curve + d * (1 - curve)) * (a.rcRate / 1000);
      return constrain(2000 * use * cmd, -SETPOINT_RATE_LIMIT, SETPOINT_RATE_LIMIT);
    }
    case RATES_TYPE.ACTUAL: {
      const e0 = a.expo / 100;
      const e = abs * (p5(d) * e0 + d * (1 - e0));
      const center = a.rcRate * 10;
      const stick = Math.max(0, a.rate * 10 - center);
      return d * center + stick * e;
    }
    case RATES_TYPE.QUICK: {
      // в прошивке rcRate и maxDPS — uint16_t
      const rcRate = a.rcRate * 2;
      if (rcRate === 0) return 0;
      const maxDPS = Math.max(a.rate * 10, rcRate);
      const e = a.expo / 100;
      const sfc = (maxDPS / rcRate - 1) / (maxDPS / rcRate);
      if (quickRcExpo) {
        const curve = p3(d) * e + d * (1 - e);
        const sf = 1 / constrain(1 - abs * sfc, 0.01, 1);
        return constrain(curve * rcRate * sf, -SETPOINT_RATE_LIMIT, SETPOINT_RATE_LIMIT);
      }
      const curve = p3(abs) * e + abs * (1 - e);
      const sf = 1 / constrain(1 - curve * sfc, 0.01, 1);
      return constrain(d * rcRate * sf, -SETPOINT_RATE_LIMIT, SETPOINT_RATE_LIMIT);
    }
    default: {
      // BETAFLIGHT
      let dd = d;
      if (a.expo) {
        const e = a.expo / 100;
        dd = d * p3(abs) * e + d * (1 - e);
      }
      let rc = a.rcRate / 100;
      if (rc > 2) rc += RC_RATE_INCREMENTAL * (rc - 2);
      let r = 200 * rc * dd;
      if (a.rate) r *= 1 / constrain(1 - abs * (a.rate / 100), 0.01, 1);
      return r;
    }
  }
}

/** setpoint с учётом rate_limit — то, что идёт в PID до сглаживания */
export function setpointFor(p: RateProfile, axis: number, d: number): number {
  const a = p.axes[axis];
  const v = applyRates(p.type, a, d, p.quickRcExpo);
  return constrain(v, -a.limit, a.limit);
}

/** делитель rcCommand → отклонение стика, как rcCommandDivider / rcCommandYawDivider */
export function stickDivider(p: RateProfile, axis: number): number {
  return 500 - (axis === 2 ? p.yawDeadband : p.deadband);
}

/** отклонение стика из записанного rcCommand (−1…1) */
export function deflection(p: RateProfile, axis: number, rcCommand: number): number {
  return constrain(rcCommand / stickDivider(p, axis), -1, 1);
}

export function maxRate(p: RateProfile, axis: number): number {
  return Math.abs(setpointFor(p, axis, 1));
}

/** чувствительность в центре стика, °/с на полный ход (наклон кривой у нуля × 1) */
export function centerSensitivity(p: RateProfile, axis: number): number {
  const h = 1e-6;
  return (setpointFor(p, axis, h) - setpointFor(p, axis, -h)) / (2 * h);
}

/** кривая на сетке отклонений 0…1 */
export function curve(p: RateProfile, axis: number, points = 101): { x: Float32Array; y: Float32Array } {
  const x = new Float32Array(points), y = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    x[i] = i / (points - 1);
    y[i] = setpointFor(p, axis, x[i]);
  }
  return { x, y };
}

const pick = (H: Record<string, string>, k: string, i: number, def: number): number => {
  const a = nums(H, k);
  if (!a.length) return def;
  const v = a.length > i ? a[i] : a[a.length - 1];
  return Number.isFinite(v) ? v : def;
};

/** профиль рейтов из заголовка лога (активный rate profile на момент начала записи) */
export function ratesFromHeader(H: Record<string, string>): RateProfile | null {
  if (H.rc_rates === undefined || H.rates === undefined) return null;
  const axes = [0, 1, 2].map((i) => ({
    rcRate: pick(H, 'rc_rates', i, 100),
    rate: pick(H, 'rates', i, 70),
    expo: pick(H, 'rc_expo', i, 0),
    limit: pick(H, 'rate_limits', i, SETPOINT_RATE_LIMIT),
  }));
  return {
    type: pick(H, 'rates_type', 0, RATES_TYPE.BETAFLIGHT),
    axes,
    quickRcExpo: pick(H, 'quickrates_rc_expo', 0, 0),
    deadband: pick(H, 'deadband', 0, 0),
    yawDeadband: pick(H, 'yaw_deadband', 0, 0),
  };
}

export const cloneProfile = (p: RateProfile): RateProfile => ({ ...p, axes: p.axes.map((a) => ({ ...a })) });

export function sameProfile(a: RateProfile, b: RateProfile): boolean {
  return a.type === b.type && a.quickRcExpo === b.quickRcExpo && a.axes.every((x, i) => {
    const y = b.axes[i];
    return x.rcRate === y.rcRate && x.rate === y.rate && x.expo === y.expo && x.limit === y.limit;
  });
}

/**
 * Диапазоны значений (settings.c: CONTROL_RATE_CONFIG_RC_RATES_MAX 255, RATE_MAX 255,
 * RC_EXPO_MAX 100) — общие для всех типов; что они значат, зависит от типа.
 */
export const RATE_RANGES = {
  rcRate: { min: 1, max: 255 },
  rate: { min: 0, max: 255 },
  expo: { min: 0, max: 100 },
  limit: { min: RATE_LIMIT_MIN, max: SETPOINT_RATE_LIMIT },
};

/** имена CLI для оси (как в settings.c) */
const AX = ['roll', 'pitch', 'yaw'];
export const cliName = {
  rcRate: (a: number): string => `${AX[a]}_rc_rate`,
  rate: (a: number): string => `${AX[a]}_srate`,
  expo: (a: number): string => `${AX[a]}_expo`,
  limit: (a: number): string => `${AX[a]}_rate_limit`,
};

/** плоский вид профиля под именами CLI (для общего генератора CLI) */
export function profileToCli(p: RateProfile): Record<string, number> {
  const o: Record<string, number> = { rates_type: p.type, quickrates_rc_expo: p.quickRcExpo };
  p.axes.forEach((a, i) => {
    o[cliName.rcRate(i)] = a.rcRate;
    o[cliName.rate(i)] = a.rate;
    o[cliName.expo(i)] = a.expo;
    o[cliName.limit(i)] = a.limit;
  });
  return o;
}

/**
 * Подбор параметров другого типа под ту же кривую. Ошибка — относительная (доля от
 * значения кривой с небольшим полом): у центра °/с маленькие, но именно там пилот
 * проводит большую часть времени, и 20 → 90 °/с там чувствуется сильнее, чем 790 → 800
 * у упора. Плюс отдельный вес на max rate. Перебор по сетке + уточнение.
 * Не все кривые повторимы точно — возвращаем ошибку в °/с (СКЗ по ходу стика) и
 * чувствительность в центре до/после.
 */
export function convertProfile(p: RateProfile, toType: number): { profile: RateProfile; rmsErr: number[]; center: [number, number][] } {
  const out = cloneProfile(p);
  out.type = toType;
  const rmsErr: number[] = [];
  const center: [number, number][] = [];
  const xs = Array.from({ length: 41 }, (_, i) => i / 40);
  for (let ax = 0; ax < 3; ax++) {
    const target = xs.map((x) => setpointFor(p, ax, x));
    const tMax = Math.max(1, Math.abs(target[target.length - 1]));
    const floor = 0.03 * tMax;
    const err = (a: AxisRates): number => {
      let s = 0;
      for (let i = 1; i < xs.length; i++) {
        const d = (applyRates(toType, a, xs[i], p.quickRcExpo) - target[i]) / (Math.abs(target[i]) + floor);
        s += (i === xs.length - 1 ? 200 : 1) * d * d;
      }
      return s;
    };
    let best: AxisRates = { ...p.axes[ax] };
    let bestE = Infinity;
    const R = RATE_RANGES;
    // грубая сетка
    for (let rc = R.rcRate.min; rc <= R.rcRate.max; rc += 4)
      for (let r = R.rate.min; r <= R.rate.max; r += 4)
        for (let e = 0; e <= 100; e += 10) {
          const cand = { rcRate: rc, rate: r, expo: e, limit: p.axes[ax].limit };
          const v = err(cand);
          if (v < bestE) { bestE = v; best = cand; }
        }
    // уточнение по единице
    let improved = true;
    while (improved) {
      improved = false;
      for (const k of ['rcRate', 'rate', 'expo'] as const)
        for (const s of [-3, -2, -1, 1, 2, 3]) {
          const cand = { ...best, [k]: best[k] + s };
          if (cand[k] < R[k].min || cand[k] > R[k].max) continue;
          const v = err(cand);
          if (v < bestE - 1e-9) { bestE = v; best = cand; improved = true; }
        }
    }
    out.axes[ax] = best;
    let se = 0;
    for (let i = 0; i < xs.length; i++) se += (applyRates(toType, best, xs[i], p.quickRcExpo) - target[i]) ** 2;
    rmsErr.push(Math.sqrt(se / xs.length));
    center.push([centerSensitivity(p, ax), centerSensitivity(out, ax)]);
  }
  return { profile: out, rmsErr, center };
}
