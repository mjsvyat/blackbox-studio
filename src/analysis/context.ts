// Общий контекст анализа одного лога: тайминг, производные ряды (газ %, частота
// моторов в Гц, нормированная команда моторов), параметры борта из заголовка.

import { Column, DecodedLog, col } from '../decoder/decoder';
import { FirmwareInfo, LoopTiming, loopTiming, num, nums, parseFirmware } from '../decoder/header';

export interface LogContext {
  log: DecodedLog;
  fw: FirmwareInfo;
  timing: LoopTiming;
  /** фактическая частота логирования по медиане шага времени, Гц */
  measuredHz: number;
  /** используемая в расчётах частота (заголовок, если совпадает с фактом ±5 %) */
  fs: number;
  n: number;
  /** время от начала лога, с */
  tSec: Float64Array;
  motorPoles: number;
  motorMin: number;
  motorMax: number;
  motorCount: number;
  /** газ со стика 0..100 % (rcCommand[3]) */
  thrPct: Float32Array;
  /** средняя частота вращения моторов, Гц; null — нет eRPM в логе */
  motorHz: Float32Array | null;
  /** частота каждого мотора, Гц */
  motorHzEach: Float32Array[] | null;
  /** команда моторов 0..1 (среднее по моторам) */
  motorAvg: Float32Array;
  motorNorm: Float32Array[];
  acc1G: number;
  cells: number;
  hasGyroUnfilt: boolean;
  /** gyroUnfilt взят из debug[0..2] (debug_mode = GYRO_SCALED, логи до 4.5) */
  unfiltFromDebug: boolean;
  hasErpm: boolean;
  hasAmperage: boolean;
  warnings: string[];
}

/** debug_mode = GYRO_SCALED (номер одинаковый во всех 4.x) */
export const DEBUG_GYRO_SCALED = 6;

function median(a: number[]): number {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

function nonZero(c: Column | null): boolean {
  if (!c) return false;
  for (let i = 0; i < c.length; i += 7) if (c[i] !== 0) return true;
  return false;
}

export function buildContext(log: DecodedLog): LogContext {
  const H = log.header;
  const timing = loopTiming(H);
  const n = log.n;
  const warnings: string[] = [];
  const tSec = new Float64Array(n);
  const t0 = n ? log.time[0] : 0;
  for (let i = 0; i < n; i++) tSec[i] = (log.time[i] - t0) / 1e6;

  const dts: number[] = [];
  for (let i = 1; i < Math.min(n, 20001); i += 10) dts.push(log.time[i] - log.time[i - 1]);
  const medDt = median(dts);
  const measuredHz = medDt > 0 ? 1e6 / medDt : timing.logHz;
  // Частоту берём из заголовка: на битом логе медиана шага времени врёт (проверено
  // на логе с 97 % потерь — 31 Гц вместо 2 кГц). Расхождение только сообщаем.
  const fs = timing.logHz;
  if (log.holes.length === 0 && Number.isFinite(measuredHz) && Math.abs(measuredHz - timing.logHz) / timing.logHz > 0.05) {
    warnings.push(`Частота логирования по заголовку ${timing.logHz.toFixed(0)} Гц, а по меткам времени ${measuredHz.toFixed(0)} Гц. Проверь looptime / pid_process_denom / P interval.`);
  }

  const motorOutput = nums(H, 'motorOutput');
  const motorMin = motorOutput[0] ?? 158;
  const motorMax = motorOutput[1] ?? 2047;
  const motorPoles = num(H, 'motor_poles', 14);

  const motors: Column[] = [];
  for (let m = 0; m < 8; m++) {
    const c = col(log, `motor[${m}]`);
    if (c) motors.push(c);
  }
  const motorCount = motors.length;
  const range = Math.max(1, motorMax - motorMin);
  const motorNorm = motors.map((c) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = (c[i] - motorMin) / range;
    return a;
  });
  const motorAvg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const a of motorNorm) s += a[i];
    motorAvg[i] = motorCount ? s / motorCount : 0;
  }

  const rc3 = col(log, 'rcCommand[3]');
  const thrPct = new Float32Array(n);
  if (rc3) for (let i = 0; i < n; i++) thrPct[i] = Math.min(100, Math.max(0, (rc3[i] - 1000) / 10));

  const erpm: Column[] = [];
  for (let m = 0; m < motorCount; m++) {
    const c = col(log, `eRPM[${m}]`);
    if (c) erpm.push(c);
  }
  const hasErpm = erpm.length === motorCount && motorCount > 0 && erpm.some(nonZero);
  let motorHz: Float32Array | null = null;
  let motorHzEach: Float32Array[] | null = null;
  if (hasErpm) {
    // eRPM в логе хранится как eRPM/100; Гц мотора = eRPM×100 / (полюса/2) / 60
    const k = 100 / (motorPoles / 2) / 60;
    motorHzEach = erpm.map((c) => {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = c[i] * k;
      return a;
    });
    motorHz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const a of motorHzEach) s += a[i];
      motorHz[i] = s / motorHzEach.length;
    }
  }

  // До 4.5 gyroUnfilt в лог не пишется: гироскоп до фильтров — только в debug[0..2] при
  // debug_mode = GYRO_SCALED (6 во всех 4.x; так велят писать логи в чате Blackbox 2.0).
  // Проверено на логах 4.2.11 и 4.3.0: debug[0] ≈ gyroADC[0] в °/с (корреляция 0.97–0.996).
  // Подставляем как gyroUnfilt — дальше весь анализ одинаковый.
  let unfiltFromDebug = false;
  if (log.index['gyroUnfilt[0]'] === undefined && H['debug_mode'] === String(DEBUG_GYRO_SCALED)
    && [0, 1, 2].every((a) => log.index[`debug[${a}]`] !== undefined) && nonZero(col(log, 'debug[0]'))) {
    for (const a of [0, 1, 2]) log.index[`gyroUnfilt[${a}]`] = log.index[`debug[${a}]`];
    unfiltFromDebug = true;
  }
  const hasGyroUnfilt = [0, 1, 2].every((a) => log.index[`gyroUnfilt[${a}]`] !== undefined) && nonZero(col(log, 'gyroUnfilt[0]'));
  const amp = col(log, 'amperageLatest');
  const hasAmperage = nonZero(amp);

  // число банок: по максимальному напряжению в первые секунды
  const vb = col(log, 'vbatLatest');
  let cells = 0;
  if (vb && n) {
    let mx = 0;
    for (let i = 0; i < Math.min(n, Math.round(fs * 3)); i++) if (vb[i] > mx) mx = vb[i];
    cells = mx > 0 ? Math.max(1, Math.ceil(mx / 100 / 4.35)) : 0;
  }

  return {
    log, fw: parseFirmware(H), timing, measuredHz, fs, n, tSec,
    motorPoles, motorMin, motorMax, motorCount, thrPct, motorHz, motorHzEach, motorAvg, motorNorm,
    acc1G: num(H, 'acc_1G', 2048), cells, hasGyroUnfilt, unfiltFromDebug, hasErpm, hasAmperage, warnings,
  };
}
