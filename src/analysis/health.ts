// Моторы, питание, связь, события — компактный порт bb-tools/analyze.js,
// crashscan.js, ripple.js, link.js для светофора MVP. Полные вкладки — этап 8.

import cfg from '../config/analysis.json';
import { FAILSAFE_PHASES, FLIGHT_MODES, bitNames } from '../decoder/constants';
import { col } from '../decoder/decoder';
import { LogContext } from './context';
import { FlightMask } from './flightMask';

const pct = (a: number[], p: number): number => {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

export interface Anomaly {
  kind: 'ALL_MOTORS_SAT' | 'MOTOR_SAT' | 'MOTOR_DESYNC' | 'IMPACT' | 'BURST' | 'GYRO_CLIP' | 'VBAT_DIP' | 'RX_LOSS' | 'FAILSAFE' | 'TRACKING_FAIL';
  t0: number;
  t1: number;
  motor?: number;
  value?: number;
  text: string;
}

export interface MotorStats {
  /** % времени полёта, когда хотя бы один мотор ≥ saturationNorm */
  satPct: number;
  /** % времени, когда все моторы ≥ 0.9 (потеря авторитета) */
  allSatPct: number;
  /** средняя команда каждого мотора на крейсере, 0..1 */
  cruiseAvg: number[];
  /** разброс средних команд на крейсере, % от среднего */
  spreadPct: number | null;
  /** самый нагруженный мотор (по средней команде на крейсере) */
  heaviest: number | null;
  desyncs: number;
}

export interface PowerStats {
  cells: number;
  vStart: number | null;
  /** 1-й перцентиль напряжения на банку в полёте */
  minCell: number | null;
  rippleP50: number | null;
  rippleP99: number | null;
  /** датчик тока упирается в предел: значение «полки», А; null — нет */
  currentClipA: number | null;
  /** сопротивление пакет+проводка, мОм; null — нет датчика тока или мало данных */
  resistanceMOhm: number | null;
  maxAmp: number | null;
}

export interface LinkStats {
  hasRssi: boolean;
  rssiAvgPct: number | null;
  rssiMinPct: number | null;
  lowSharePct: number | null;
  rxLossCount: number;
  failsafeCount: number;
}

export interface ModeSpan {
  t0: number;
  t1: number;
  modes: string[];
  failsafe: string;
  rxOk: boolean;
}

export interface HealthResult {
  motors: MotorStats;
  power: PowerStats;
  link: LinkStats;
  anomalies: Anomaly[];
  modes: ModeSpan[];
}

export function analyzeHealth(ctx: LogContext, fm: FlightMask): HealthResult {
  const { n, fs, tSec, motorNorm, motorCount, log } = ctx;
  const anomalies: Anomaly[] = [];
  const M = cfg.motors;

  // --- моторы ---
  let inFlight = 0, sat = 0, allSat = 0;
  const cruiseSum = new Float64Array(motorCount);
  let cruiseN = 0;
  const g = [0, 1, 2].map((a) => col(log, `gyroADC[${a}]`)!);
  let satStart = -1;
  for (let i = 0; i < n; i++) {
    if (!fm.mask[i]) continue;
    inFlight++;
    let mn = 1e9, mx = -1e9;
    for (let m = 0; m < motorCount; m++) {
      const v = motorNorm[m][i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (mx >= M.saturationNorm) sat++;
    if (mn >= 0.9) {
      allSat++;
      if (satStart < 0) satStart = i;
    } else if (satStart >= 0) {
      if ((i - satStart) / fs > 0.05) anomalies.push({ kind: 'ALL_MOTORS_SAT', t0: tSec[satStart], t1: tSec[i], text: 'Все моторы ≥ 90 % — не хватает тяги/авторитета' });
      satStart = -1;
    }
    const gm = Math.max(Math.abs(g[0][i]), Math.abs(g[1][i]), Math.abs(g[2][i]));
    if (ctx.thrPct[i] > 20 && ctx.thrPct[i] < 60 && gm < 100) {
      for (let m = 0; m < motorCount; m++) cruiseSum[m] += motorNorm[m][i];
      cruiseN++;
    }
  }
  const cruiseAvg = Array.from(cruiseSum, (s) => (cruiseN ? s / cruiseN : NaN));
  let spreadPct: number | null = null;
  let heaviest: number | null = null;
  if (cruiseN > fs * 2 && motorCount) {
    const mu = cruiseAvg.reduce((s, x) => s + x, 0) / motorCount;
    spreadPct = mu > 0 ? ((Math.max(...cruiseAvg) - Math.min(...cruiseAvg)) / mu) * 100 : null;
    heaviest = cruiseAvg.indexOf(Math.max(...cruiseAvg));
  }

  // десинки: команда > 20 %, eRPM ≈ 0, остальные крутятся (как в analyze.js)
  let desyncs = 0;
  if (ctx.motorHzEach) {
    const minLen = Math.round((M.desyncMinMs / 1000) * fs);
    for (let m = 0; m < motorCount; m++) {
      let st = -1;
      for (let i = 0; i < n; i++) {
        let othersOk = 0;
        for (let k = 0; k < motorCount; k++) if (k !== m && ctx.motorHzEach[k][i] > 30) othersOk++;
        const bad = motorNorm[m][i] > 0.2 && ctx.motorHzEach[m][i] < 10 && othersOk >= 2;
        if (bad && st < 0) st = i;
        else if (!bad && st >= 0) {
          if (i - st >= minLen) {
            desyncs++;
            anomalies.push({ kind: 'MOTOR_DESYNC', t0: tSec[st], t1: tSec[i], motor: m, text: `Мотор ${m + 1}: команда есть, оборотов нет (${(((i - st) / fs) * 1000).toFixed(0)} мс) — похоже на десинк` });
          }
          st = -1;
        }
      }
    }
  }

  // --- питание ---
  const vb = col(log, 'vbatLatest');
  const amp = ctx.hasAmperage ? col(log, 'amperageLatest') : null;
  const power: PowerStats = { cells: ctx.cells, vStart: null, minCell: null, rippleP50: null, rippleP99: null, resistanceMOhm: null, maxAmp: null, currentClipA: null };
  if (vb && n && ctx.cells) {
    power.vStart = vb[0] / 100;
    const vs: number[] = [];
    for (let i = 0; i < n; i += 4) if (fm.mask[i]) vs.push(vb[i] / 100 / ctx.cells);
    power.minCell = vs.length ? pct(vs, 0.01) : null;
    // размах в окне 20 мс
    const w = Math.max(2, Math.round(0.02 * fs));
    const rip: number[] = [];
    for (let s = 0; s + w <= n; s += w) {
      if (!fm.mask[s] || !fm.mask[s + w - 1]) continue;
      let mn = 1e9, mx = -1e9;
      for (let i = s; i < s + w; i++) {
        if (vb[i] < mn) mn = vb[i];
        if (vb[i] > mx) mx = vb[i];
      }
      rip.push((mx - mn) / 100);
    }
    power.rippleP50 = rip.length ? pct(rip, 0.5) : null;
    power.rippleP99 = rip.length ? pct(rip, 0.99) : null;
    if (amp) {
      // «полка» датчика тока: максимум держится много кадров подряд — АЦП в упоре
      let ampMax = -Infinity;
      for (let i = 0; i < n; i++) if (amp[i] > ampMax) ampMax = amp[i];
      let run = 0, bestRun = 0;
      for (let i = 0; i < n; i++) {
        if (amp[i] === ampMax) { run++; if (run > bestRun) bestRun = run; } else run = 0;
      }
      const clipped = ampMax > 0 && bestRun >= cfg.power.currentClipFrames;
      if (clipped) power.currentClipA = ampMax / 100;
      // регрессия dV = −R·dI. В отличие от ripple.js берём отклонения от скользящего
      // среднего за 0.5 с: так медленный разряд пакета за полёт не портит оценку.
      const W = Math.max(4, Math.round(0.5 * fs));
      const preV = new Float64Array(n + 1), preA = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) {
        preV[i + 1] = preV[i] + vb[i] / 100;
        preA[i + 1] = preA[i] + amp[i] / 100;
      }
      let sx = 0, sy = 0, sxx = 0, sxy = 0, k = 0, maxA = 0;
      for (let i = W; i < n - W; i++) {
        if (!fm.mask[i]) continue;
        const a = amp[i] / 100;
        if (a > maxA) maxA = a;
        if (a <= 0 || a > 300 || (clipped && amp[i] >= ampMax)) continue;
        const da = a - (preA[i + W] - preA[i - W]) / (2 * W);
        const dv = vb[i] / 100 - (preV[i + W] - preV[i - W]) / (2 * W);
        sx += da; sy += dv; sxx += da * da; sxy += da * dv; k++;
      }
      power.maxAmp = maxA;
      const den = k * sxx - sx * sx;
      if (k > fs * 5 && den > 0) {
        const slope = (k * sxy - sx * sy) / den;
        const r = -slope * 1000;
        if (r > 0 && r < 500) power.resistanceMOhm = r;
      }
    }
    // провалы ниже 3.0 В/банку
    let last = -1e9;
    for (let i = 0; i < n; i++) {
      const c = vb[i] / 100 / ctx.cells;
      if (c < 3.0 && tSec[i] - last > 1) {
        last = tSec[i];
        anomalies.push({ kind: 'VBAT_DIP', t0: tSec[i], t1: tSec[i], value: c, text: `Просадка до ${c.toFixed(2)} В/банку` });
      }
    }
  }

  // --- гироскоп упёрся в предел шкалы (ICM42688P/BMI270: ±2000 °/с) ---
  const gu = ctx.hasGyroUnfilt ? [0, 1, 2].map((a) => col(log, `gyroUnfilt[${a}]`)!) : g;
  const clip = cfg.noise.gyroClipDps;
  let cs = -1;
  for (let i = 0; i <= n; i++) {
    const c = i < n && (Math.abs(gu[0][i]) >= clip || Math.abs(gu[1][i]) >= clip || Math.abs(gu[2][i]) >= clip);
    if (c && cs < 0) cs = i;
    else if (!c && cs >= 0) {
      const ms = ((i - cs) / fs) * 1000;
      anomalies.push({ kind: 'GYRO_CLIP', t0: tSec[cs], t1: tSec[i - 1], value: ms, text: `Гироскоп упёрся в предел шкалы на ${ms.toFixed(1)} мс — реального движения в это время не видно, PID работал вслепую` });
      cs = -1;
    }
  }

  // --- удары ---
  for (const c of fm.crashes) anomalies.push({ kind: 'IMPACT', t0: c.t, t1: c.t, value: c.g, text: `Удар ${c.g.toFixed(1)} g` });

  // --- связь и режимы ---
  const rssi = col(log, 'rssi');
  const link: LinkStats = { hasRssi: false, rssiAvgPct: null, rssiMinPct: null, lowSharePct: null, rxLossCount: 0, failsafeCount: 0 };
  if (rssi) {
    let s = 0, mn = 1e9, low = 0, cnt = 0, nz = false;
    for (let i = 0; i < n; i += 2) {
      const p = rssi[i] / 10.23;
      if (rssi[i]) nz = true;
      s += p; cnt++;
      if (p < mn) mn = p;
      if (p < cfg.link.rssiLowPct) low++;
    }
    if (nz && cnt) {
      link.hasRssi = true;
      link.rssiAvgPct = s / cnt;
      link.rssiMinPct = mn;
      link.lowSharePct = (low / cnt) * 100;
    }
  }
  const modes: ModeSpan[] = [];
  const S = log.slowFieldNames;
  const iMode = S.indexOf('flightModeFlags'), iFs = S.indexOf('failsafePhase'), iRx = S.indexOf('rxSignalReceived');
  const t0 = n ? log.time[0] : 0;
  const tEnd = n ? tSec[n - 1] : 0;
  for (let k = 0; k < log.slow.length; k++) {
    const r = log.slow[k];
    const a = Math.max(0, (r.t - t0) / 1e6);
    const b = k + 1 < log.slow.length ? (log.slow[k + 1].t - t0) / 1e6 : tEnd;
    const fsPhase = iFs >= 0 ? FAILSAFE_PHASES[r.v[iFs]] ?? String(r.v[iFs]) : 'IDLE';
    const rxOk = iRx >= 0 ? r.v[iRx] !== 0 : true;
    modes.push({ t0: a, t1: b, modes: iMode >= 0 ? bitNames(r.v[iMode], FLIGHT_MODES) : [], failsafe: fsPhase, rxOk });
    if (!rxOk) {
      link.rxLossCount++;
      anomalies.push({ kind: 'RX_LOSS', t0: a, t1: b, text: 'Нет сигнала приёмника' });
    }
    if (fsPhase !== 'IDLE') {
      link.failsafeCount++;
      anomalies.push({ kind: 'FAILSAFE', t0: a, t1: b, text: `Failsafe: ${fsPhase}` });
    }
  }

  anomalies.sort((a, b) => a.t0 - b.t0);
  return {
    motors: {
      satPct: inFlight ? (sat / inFlight) * 100 : 0,
      allSatPct: inFlight ? (allSat / inFlight) * 100 : 0,
      cruiseAvg, spreadPct, heaviest, desyncs,
    },
    power, link, anomalies, modes,
  };
}
