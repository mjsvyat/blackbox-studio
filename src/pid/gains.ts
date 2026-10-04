// PID из заголовка лога и порт simplified_tuning.c (calculateNewPidValues) по версиям:
//  ≤ 4.5: D по умолчанию = D_MAX (40/46/0), d_min = D_MIN (30/34/0), ползунок simplified_dmax_gain
//         задаёт, насколько D поднимается над d_min;
//  ≥ 2025.12 (d_max вместо d_min): D = базовый (30/34/0), d_max = D_MAX (40/46/0),
//         ползунок simplified_d_max_gain.
// Значения — целые: в прошивке constrain() принимает int, дробная часть отбрасывается.
// Проверено на заголовках логов 4.5.2 и 2026.6.1 (tests/pid.test.ts).

import { nums } from '../decoder/header';

export interface PidGains {
  /** [ось] → P, I, D, F */
  P: number[];
  I: number[];
  D: number[];
  F: number[];
  /** d_max (≥ 2025.12) или d_min (≤ 4.5) по осям; null — нет в заголовке */
  dExtra: number[] | null;
  dExtraKind: 'd_max' | 'd_min' | null;
}

export interface SimplifiedPids {
  mode: number;
  master: number;
  pi: number;
  i: number;
  d: number;
  dExtra: number;
  ff: number;
  pitchD: number;
  pitchPi: number;
}

const AX = ['roll', 'pitch', 'yaw'];

export function gainsFromHeader(H: Record<string, string>): PidGains {
  const P: number[] = [], I: number[] = [], D: number[] = [];
  AX.forEach((a) => {
    const v = nums(H, `${a}PID`);
    P.push(v[0] ?? NaN); I.push(v[1] ?? NaN); D.push(v[2] ?? NaN);
  });
  const ff = nums(H, 'ff_weight');
  const F = [0, 1, 2].map((i) => ff[i] ?? NaN);
  let dExtra: number[] | null = null;
  let dExtraKind: PidGains['dExtraKind'] = null;
  if (H.d_max !== undefined) { dExtra = nums(H, 'd_max'); dExtraKind = 'd_max'; }
  else if (H.d_min !== undefined) { dExtra = nums(H, 'd_min'); dExtraKind = 'd_min'; }
  return { P, I, D, F, dExtra, dExtraKind };
}

/** имена ползунков в CLI: в ≤ 4.5 — simplified_dmax_gain, позже — simplified_d_max_gain */
export function simplifiedFromHeader(H: Record<string, string>): { s: SimplifiedPids; dExtraName: string } | null {
  if (H.simplified_pids_mode === undefined) return null;
  const g = (k: string, def: number): number => {
    const v = Number(H[k]);
    return Number.isFinite(v) ? v : def;
  };
  const dExtraName = H.simplified_d_max_gain !== undefined ? 'simplified_d_max_gain' : 'simplified_dmax_gain';
  return {
    s: {
      mode: g('simplified_pids_mode', 0),
      master: g('simplified_master_multiplier', 100),
      pi: g('simplified_pi_gain', 100),
      i: g('simplified_i_gain', 100),
      d: g('simplified_d_gain', 100),
      dExtra: g(dExtraName, 100),
      ff: g('simplified_feedforward_gain', 100),
      pitchD: g('simplified_pitch_d_gain', 100),
      pitchPi: g('simplified_pitch_pi_gain', 100),
    },
    dExtraName,
  };
}

const PID_GAIN_MAX = 250;
const F_GAIN_MAX = 1000;
const ci = (v: number, max: number): number => Math.min(max, Math.max(0, Math.trunc(v)));

/** calculateNewPidValues; kind — какая версия (см. шапку). Оси выше mode не трогаются. */
export function simplifiedPids(s: SimplifiedPids, kind: 'd_max' | 'd_min', base: PidGains): PidGains {
  const out: PidGains = { P: [...base.P], I: [...base.I], D: [...base.D], F: [...base.F], dExtra: base.dExtra ? [...base.dExtra] : null, dExtraKind: kind };
  if (!out.dExtra) out.dExtra = [0, 0, 0];
  const DEF = kind === 'd_max'
    ? { P: [45, 47, 45], I: [80, 84, 80], D: [30, 34, 0], F: [120, 125, 120], X: [40, 46, 0] }
    : { P: [45, 47, 45], I: [80, 84, 80], D: [40, 46, 0], F: [120, 125, 120], X: [30, 34, 0] };
  const m = s.master / 100, pi = s.pi / 100, d = s.d / 100, ff = s.ff / 100, ig = s.i / 100, xg = s.dExtra / 100;
  for (let a = 0; a <= Math.min(2, s.mode); a++) {
    const pd = a === 1 ? s.pitchD / 100 : 1;
    const ppi = a === 1 ? s.pitchPi / 100 : 1;
    out.P[a] = ci(DEF.P[a] * m * pi * ppi, PID_GAIN_MAX);
    out.I[a] = ci(DEF.I[a] * m * pi * ig * ppi, PID_GAIN_MAX);
    out.F[a] = ci(DEF.F[a] * m * ppi * ff, F_GAIN_MAX);
    if (kind === 'd_max') {
      out.D[a] = ci(DEF.D[a] * m * d * pd, PID_GAIN_MAX);
      const g = DEF.X[a] > 0 ? xg + (1 - xg) * (DEF.D[a] / DEF.X[a]) : 1;
      out.dExtra[a] = ci(DEF.X[a] * m * d * pd * g, PID_GAIN_MAX);
    } else {
      // ≤ 4.5: X — d_min, D — максимум
      const r = DEF.X[a] > 0 ? 1 + ((DEF.D[a] - DEF.X[a]) / DEF.X[a]) * xg : 1;
      out.D[a] = ci(DEF.X[a] * m * d * pd * r, PID_GAIN_MAX);
      out.dExtra[a] = ci(DEF.X[a] * m * d * pd, PID_GAIN_MAX);
    }
  }
  return out;
}

/** плоский вид для CLI */
export function gainsToCli(g: PidGains): Record<string, number> {
  const o: Record<string, number> = {};
  AX.forEach((a, i) => {
    if (Number.isFinite(g.P[i])) o[`p_${a}`] = g.P[i];
    if (Number.isFinite(g.I[i])) o[`i_${a}`] = g.I[i];
    if (Number.isFinite(g.D[i])) o[`d_${a}`] = g.D[i];
    if (Number.isFinite(g.F[i])) o[`f_${a}`] = g.F[i];
    if (g.dExtra && g.dExtraKind && Number.isFinite(g.dExtra[i])) o[`${g.dExtraKind}_${a}`] = g.dExtra[i];
  });
  return o;
}

export function simplifiedToCli(s: SimplifiedPids, dExtraName: string): Record<string, number> {
  return {
    simplified_pids_mode: s.mode,
    simplified_master_multiplier: s.master,
    simplified_pi_gain: s.pi,
    simplified_i_gain: s.i,
    simplified_d_gain: s.d,
    [dExtraName]: s.dExtra,
    simplified_feedforward_gain: s.ff,
    simplified_pitch_d_gain: s.pitchD,
    simplified_pitch_pi_gain: s.pitchPi,
  };
}
