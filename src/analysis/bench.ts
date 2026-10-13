// Распознавание теста моторов на столе (общий для советчика и карточек сводки).

import cfg from '../config/analysis.json';
import type { LogContext } from './context';

/**
 * Тест моторов на столе (blackbox_mode = MOTOR_TEST, моторы крутят ползунками конфигуратора):
 * моторы крутятся, а стик газа на нуле. Такой лог — про шум гиро от моторов, не про полёт.
 */
export function isBenchTest(c: Pick<LogContext, 'n' | 'fs' | 'thrPct' | 'motorAvg'>): boolean {
  const A = cfg.advisor;
  let spin = 0, low = 0;
  for (let i = 0; i < c.n; i += 4) {
    if (c.motorAvg[i] < A.benchMotorMin) continue;
    spin++;
    if (c.thrPct[i] < A.benchThrMaxPct) low++;
  }
  return spin * 4 >= c.fs * A.benchMinS && low >= spin * A.benchShare;
}
