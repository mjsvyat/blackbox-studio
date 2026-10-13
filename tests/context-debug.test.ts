// Логи до 4.5: гироскоп до фильтров — в debug[0..2] при debug_mode = GYRO_SCALED (6).
// Так велят писать логи в чате Blackbox 2.0; проверено на логах 4.2.11 и 4.3.0 из чата
// (debug[0] ≈ gyroADC[0] в °/с, корреляция 0.97–0.996). Сами логи чужие — в репозиторий
// не кладём, проверяем на синтетике.
import { describe, expect, it } from 'vitest';
import { buildContext, DEBUG_GYRO_SCALED } from '../src/analysis/context';
import { col } from '../src/decoder/decoder';

function fakeLog(debugMode: string, withUnfilt = false): any {
  const n = 2000;
  const names = ['gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]', 'debug[0]', 'debug[1]', 'debug[2]', 'debug[3]', ...(withUnfilt ? ['gyroUnfilt[0]', 'gyroUnfilt[1]', 'gyroUnfilt[2]'] : [])];
  const cols = names.map((nm, k) => {
    const c = new Float64Array(n);
    for (let i = 0; i < n; i++) c[i] = nm === 'debug[3]' ? 0 : 50 * Math.sin(i / (5 + k)) + (nm.startsWith('debug') ? 3 * Math.sin(i * 1.7) : 0);
    return c;
  });
  const time = new Float64Array(n);
  for (let i = 0; i < n; i++) time[i] = i * 500;
  return { header: { debug_mode: debugMode, looptime: '125', pid_process_denom: '1', 'P interval': '1/4' }, n, time, cols, index: Object.fromEntries(names.map((nm, k) => [nm, k])), holes: [] };
}

describe('gyroUnfilt из debug GYRO_SCALED (логи до 4.5)', () => {
  it('debug_mode = 6 и нет gyroUnfilt → берём debug[0..2]', () => {
    const log = fakeLog(String(DEBUG_GYRO_SCALED));
    const c = buildContext(log);
    expect(c.hasGyroUnfilt).toBe(true);
    expect(c.unfiltFromDebug).toBe(true);
    expect(col(log, 'gyroUnfilt[1]')).toBe(col(log, 'debug[1]'));
  });

  it('другой debug_mode — не подставляем', () => {
    const c = buildContext(fakeLog('50'));
    expect(c.hasGyroUnfilt).toBe(false);
    expect(c.unfiltFromDebug).toBe(false);
  });

  it('gyroUnfilt есть в логе (4.5+) — debug не трогаем', () => {
    const log = fakeLog(String(DEBUG_GYRO_SCALED), true);
    const c = buildContext(log);
    expect(c.unfiltFromDebug).toBe(false);
    expect(col(log, 'gyroUnfilt[0]')).not.toBe(col(log, 'debug[0]'));
  });
});
