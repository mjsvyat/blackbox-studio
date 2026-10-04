// Отработка PID на записанном полёте: step response по осям (деконволюция), ошибка
// трекинга setpoint, вклад P/I/D/F, «дрожь» feedforward. Кадры: чистый полёт, вне
// режимов, где setpoint задают не рейты, без насыщения моторов (там PID не властен).

import cfg from '../config/analysis.json';
import { col } from '../decoder/decoder';
import { LogContext } from '../analysis/context';
import { Lowpass, LPF_TYPE } from '../filters/primitives';
import { nonRateMask } from '../rates/analyze';
import { PidGains, gainsFromHeader } from './gains';
import { StepMetrics, StepResult, stepMetrics, stepResponse } from './stepResponse';

const C = cfg.pid;

export interface PidAxis {
  axis: number;
  step: StepResult | null;
  metrics: StepMetrics | null;
  /** данных хватает для надёжной оценки (секунды со стиками и разброс по частям) */
  enough: boolean;
  /** разброс оценки по частям полёта около пика */
  stdAtPeak: number;
  /** СКЗ ошибки трекинга (setpoint − gyro), °/с, и СКЗ самого setpoint */
  trackRms: number;
  spRms: number;
  /** СКЗ вкладов P, I, D, F (единицы PID-суммы прошивки) */
  contrib: { P: number; I: number; D: number; F: number };
  /** дрожь feedforward: доля ВЧ в axisF (NaN — F нет) */
  ffJitter: number;
}

export interface PidResult {
  axes: PidAxis[];
  gains: PidGains;
  seconds: number;
  /** исключено из-за насыщения моторов, с */
  satS: number;
}

export function analyzePid(c: LogContext, flightMask: Uint8Array): PidResult {
  const { n, fs, log, motorNorm } = c;
  const nr = nonRateMask(c);
  const satLvl = cfg.motors.saturationNorm;
  const use = new Uint8Array(n);
  let useN = 0, sat = 0;
  for (let i = 0; i < n; i++) {
    if (!flightMask[i] || nr.mask[i]) continue;
    let s = false;
    for (const m of motorNorm) if (m[i] >= satLvl) { s = true; break; }
    if (s) { sat++; continue; }
    use[i] = 1;
    useN++;
  }
  const axes: PidAxis[] = [0, 1, 2].map((a) => {
    const sp = col(log, `setpoint[${a}]`), gy = col(log, `gyroADC[${a}]`);
    const out: PidAxis = { axis: a, step: null, metrics: null, enough: false, stdAtPeak: NaN, trackRms: NaN, spRms: NaN, contrib: { P: NaN, I: NaN, D: NaN, F: NaN }, ffJitter: NaN };
    if (!sp || !gy) return out;
    out.step = stepResponse(sp, gy, use, fs, C);
    if (out.step) {
      out.metrics = stepMetrics(out.step);
      out.stdAtPeak = stdNear(out.step, out.metrics.peakMs / 1000);
      out.enough = out.step.activeS >= C.minActiveS && out.stdAtPeak <= C.maxStdAtPeak;
    }
    let se = 0, ss = 0;
    const cols = { P: col(log, `axisP[${a}]`), I: col(log, `axisI[${a}]`), D: col(log, `axisD[${a}]`), F: col(log, `axisF[${a}]`) };
    const acc = { P: 0, I: 0, D: 0, F: 0 };
    const lp = new Lowpass(LPF_TYPE.PT1, C.ffSmoothHz, 1e6 / fs);
    let fHi = 0;
    for (let i = 0; i < n; i++) {
      const f = cols.F ? cols.F[i] : 0;
      const fl = lp.apply(f);
      if (!use[i]) continue;
      se += (sp[i] - gy[i]) ** 2;
      ss += sp[i] * sp[i];
      for (const k of ['P', 'I', 'D', 'F'] as const) { const cc = cols[k]; if (cc) acc[k] += cc[i] * cc[i]; }
      fHi += (f - fl) ** 2;
    }
    if (useN) {
      out.trackRms = Math.sqrt(se / useN);
      out.spRms = Math.sqrt(ss / useN);
      for (const k of ['P', 'I', 'D', 'F'] as const) out.contrib[k] = cols[k] ? Math.sqrt(acc[k] / useN) : NaN;
      if (cols.F && acc.F > 0) out.ffJitter = Math.sqrt(fHi / acc.F);
    }
    return out;
  });
  return { axes, gains: gainsFromHeader(log.header), seconds: useN / fs, satS: sat / fs };
}

/** наибольший разброс в окне ±30 мс вокруг пика (NaN — частей не хватило) */
function stdNear(s: StepResult, tPk: number): number {
  let m = 0, any = false;
  for (let i = 0; i < s.t.length; i++) {
    if (Math.abs(s.t[i] - tPk) > 0.03) continue;
    if (!Number.isFinite(s.std[i])) return NaN;
    any = true;
    if (s.std[i] > m) m = s.std[i];
  }
  return any ? m : NaN;
}
