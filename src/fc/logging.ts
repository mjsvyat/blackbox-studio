// Настройка записи лога под тюн: доля циклов PID для ≥ protocol.minLogHz, debug GYRO_SCALED до 4.5.

import cfg from '../config/analysis.json';

export function loggingSetup(fwCode: number, cycleTimeUs: number): Record<string, number> {
  const pidHz = cycleTimeUs > 0 ? 1e6 / cycleTimeUs : 8000;
  let k = 0;
  while (k < 4 && pidHz / 2 ** (k + 1) >= cfg.protocol.minLogHz) k++;
  const to: Record<string, number> = { blackbox_sample_rate: k };
  if (fwCode && fwCode < 4_005_000) to.debug_mode = 6;
  return to;
}
