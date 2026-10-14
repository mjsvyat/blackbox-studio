// Правила по скриншотам экспертов чата Blackbox 2.0 (docs/dev/knowledge/blackbox_two.md, раздел 8):
// гиро-лоупассы при RPM-фильтрах, число динамических нотчей, частота пакетов линка.
import { afterEach, describe, expect, it } from 'vitest';
import { AdvisorInput, LpfOffCandidate, runAdvisor, setupFromHeader } from '../src/advisor/advisor';
import { setBoardClass } from '../src/config/classes';
import { cliAllowed } from '../src/fc/cli';
import { cliDiff } from '../src/params/registry';

const FW = 2_026_006_001;
const FILTERS = { simplified_gyro_filter: 1, simplified_gyro_filter_multiplier: 100, gyro_lpf1_dyn_min_hz: 250, gyro_lpf1_dyn_max_hz: 500, gyro_lpf1_static_hz: 250, gyro_lpf2_static_hz: 500, simplified_dterm_filter: 1, simplified_dterm_filter_multiplier: 100, dterm_lpf1_dyn_min_hz: 75, dterm_lpf1_dyn_max_hz: 150, dterm_lpf1_static_hz: 75, dterm_lpf2_static_hz: 150, dyn_notch_count: 3, dyn_notch_min_hz: 100, dyn_notch_max_hz: 600, rpm_filter_harmonics: 3 };

const OFF: LpfOffCandidate = {
  from: { simplified_gyro_filter: 1, gyro_lpf1_static_hz: 250, gyro_lpf1_dyn_min_hz: 250, gyro_lpf1_dyn_max_hz: 500, gyro_lpf2_static_hz: 500 },
  changes: { simplified_gyro_filter: 0, gyro_lpf1_static_hz: 0, gyro_lpf1_dyn_min_hz: 0, gyro_lpf1_dyn_max_hz: 0, gyro_lpf2_static_hz: 0 },
  gyro: 1.2, dtermRatio: 1.1, delay100: [1.4, 0.9],
};

function input(over: Partial<AdvisorInput> = {}, params: Record<string, number> = {}): AdvisorInput {
  return {
    fwCode: FW, logHz: 2000, hasUnfilt: true,
    noise: { unfilt: [6, 5, 4], filt: [1, 1, 1], dterm: [5, 5, null], peaks: [] },
    filters: { params: { ...FILTERS, ...params }, status: 'green', reason: 'ok' },
    pid: null, simplified: null, dKind: 'd_max',
    motors: { satPct: 0.2, spreadPct: 5, desyncs: 0, airClips: 0, clipT: [] }, power: { resistanceMOhm: 10, rippleP99: 0.5, cells: 6 },
    setup: { dynIdle: 25, bidir: true, pidDenom: 1, idleRpm: 3200 },
    flight: { thrTop: 95, gyroDelayMs: 1.4 },
    whatIf: { gyroLpfOff: [OFF] },
    ...over,
  };
}
const find = (r: ReturnType<typeof runAdvisor>, id: string) => r.advice.find((a) => a.id === id);

afterEach(() => setBoardClass(null));

describe('R-FLT-GYRO-LPF-OFF-01: гиро-лоупассы при RPM-фильтрах', () => {
  it('модель говорит «чисто» → выключить оба, вместо шага слайдера', () => {
    const r = runAdvisor(input());
    const a = find(r, 'R-FLT-GYRO-LPF-OFF-01')!;
    expect(a).toBeDefined();
    expect(a.safety).toBe(true);
    expect(a.changes).toEqual(OFF.changes);
    expect(find(r, 'R-FLT-GYRO-RAISE-01')).toBeUndefined();
    const cli = cliDiff(a.from, a.changes, FW);
    expect(cli.lines.every((l) => cliAllowed(l))).toBe(true);
    expect(cli.lines).toContain('set gyro_lpf2_static_hz = 0');
  });

  it('с обоими выключенными шум не зелёный → берётся вариант с LPF2', () => {
    const keep: LpfOffCandidate = { ...OFF, changes: { ...OFF.changes, gyro_lpf2_static_hz: 500 }, gyro: 1.3, delay100: [1.4, 1.1] };
    const a = find(runAdvisor(input({ whatIf: { gyroLpfOff: [{ ...OFF, gyro: 9 }, keep] } })), 'R-FLT-GYRO-LPF-OFF-01')!;
    expect(a.changes.gyro_lpf2_static_hz).toBe(500);
    expect(a.inputs.lpf2).toBe(500);
  });

  it('молчит без bidir, при PID медленнее гиро, без полного газа, на жёлтой модели, если D-term вырастет', () => {
    expect(find(runAdvisor(input({ setup: { dynIdle: 25, bidir: false, pidDenom: 1, idleRpm: null } })), 'R-FLT-GYRO-LPF-OFF-01')).toBeUndefined();
    expect(find(runAdvisor(input({ setup: { dynIdle: 25, bidir: true, pidDenom: 2, idleRpm: null } })), 'R-FLT-GYRO-LPF-OFF-01')).toBeUndefined();
    expect(find(runAdvisor(input({ flight: { thrTop: 50, gyroDelayMs: 1.4 } })), 'R-FLT-GYRO-LPF-OFF-01')).toBeUndefined();
    expect(find(runAdvisor(input({ filters: { params: FILTERS, status: 'yellow', reason: 'low-rate' } })), 'R-FLT-GYRO-LPF-OFF-01')).toBeUndefined();
    expect(find(runAdvisor(input({ whatIf: { gyroLpfOff: [{ ...OFF, dtermRatio: 10 }] } })), 'R-FLT-GYRO-LPF-OFF-01')).toBeUndefined();
    expect(find(runAdvisor(input({}, { rpm_filter_harmonics: 0 })), 'R-FLT-GYRO-LPF-OFF-01')).toBeUndefined();
  });

  it('задержка почти не меняется — не предлагаем', () => {
    expect(find(runAdvisor(input({ whatIf: { gyroLpfOff: [{ ...OFF, delay100: [1.0, 0.95] }] } })), 'R-FLT-GYRO-LPF-OFF-01')).toBeUndefined();
  });
});

describe('R-DYN-NOTCH-COUNT-01: нотчей по числу резонансов рамы', () => {
  const frame = (axis: number, hz: number) => ({ axis, kind: 'frame', hz, prominenceDb: 20 });
  it('3 нотча, один резонанс → 1', () => {
    const r = runAdvisor(input({ whatIf: {}, noise: { unfilt: [6, 5, 4], filt: [1, 1, 1], dterm: [5, 5, null], peaks: [frame(0, 300), frame(0, 310), frame(1, 305)] } }));
    const a = find(r, 'R-DYN-NOTCH-COUNT-01')!;
    expect(a.changes).toEqual({ dyn_notch_count: 1 });
  });
  it('два резонанса на одной оси → 2; уже столько — молчит', () => {
    const peaks = [frame(0, 220), frame(0, 310)];
    expect(find(runAdvisor(input({ whatIf: {}, noise: { unfilt: [6, 5, 4], filt: [1, 1, 1], dterm: [5, 5, null], peaks } })), 'R-DYN-NOTCH-COUNT-01')!.changes.dyn_notch_count).toBe(2);
    expect(find(runAdvisor(input({ whatIf: {}, noise: { unfilt: [6, 5, 4], filt: [1, 1, 1], dterm: [5, 5, null], peaks } }, { dyn_notch_count: 2 })), 'R-DYN-NOTCH-COUNT-01')).toBeUndefined();
  });
});

describe('R-LINK-RATE-01: частота пакетов линка', () => {
  it('из заголовка: 4.5+ в Гц, до 4.4 — мкс между кадрами', () => {
    expect(setupFromHeader({ rc_smoothing_rx_smoothed: '150' }, null)!.rxHz).toBe(150);
    expect(setupFromHeader({ rc_smoothing_rx_average: '20000' }, null)!.rxHz).toBe(50);
    expect(setupFromHeader({ rc_smoothing_rx_average: '6667' }, null)!.rxHz).toBe(150);
    expect(setupFromHeader({ rc_smoothing_rx_smoothed: '0' }, null)!.rxHz).toBeNull();
  });
  it('50 Гц — подсказка, 150 — нет', () => {
    const s = (rxHz: number) => ({ setup: { dynIdle: 25, bidir: true, pidDenom: 1, idleRpm: null, rxHz } });
    expect(find(runAdvisor(input(s(50))), 'R-LINK-RATE-01')!.inputs.hz).toBe(50);
    expect(find(runAdvisor(input(s(150))), 'R-LINK-RATE-01')).toBeUndefined();
  });
});
