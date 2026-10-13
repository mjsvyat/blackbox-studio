// Правила по инструкциям чата Blackbox 2.0 (docs/knowledge/blackbox_two.md): динамический
// холостой ход по классу, LPF2 при PID медленнее гиро, обязательные фильтры D-term.
import { afterEach, describe, expect, it } from 'vitest';
import { AdvisorInput, runAdvisor, setupFromHeader } from '../src/advisor/advisor';
import { buildContext } from '../src/analysis/context';
import { adviseLog, analyzeLog, isBenchTest } from '../src/analysis/pipeline';
import { setBoardClass } from '../src/config/classes';
import { decodeLog } from '../src/decoder/decoder';
import { cliAllowed } from '../src/fc/cli';
import { cliDiff } from '../src/params/registry';
import { BIG_DUMP, SMALL_DUMP, hasFixture, readRange } from './helpers';

const FW = 2_026_006_001;
const FILTERS = { simplified_gyro_filter: 1, simplified_gyro_filter_multiplier: 160, gyro_lpf1_dyn_min_hz: 0, gyro_lpf1_dyn_max_hz: 0, gyro_lpf1_static_hz: 0, gyro_lpf2_static_hz: 800, simplified_dterm_filter: 1, simplified_dterm_filter_multiplier: 140, dterm_lpf1_dyn_min_hz: 0, dterm_lpf1_dyn_max_hz: 0, dterm_lpf1_static_hz: 105, dterm_lpf2_static_hz: 210, dyn_notch_count: 2, dyn_notch_min_hz: 90, dyn_notch_max_hz: 800 };

function input(over: Partial<AdvisorInput> = {}, params: Record<string, number> = {}): AdvisorInput {
  return {
    fwCode: FW, logHz: 2000, hasUnfilt: true,
    noise: { unfilt: [6, 5, 4], filt: [2, 2, 2], dterm: [10, 9, null], peaks: [] },
    filters: { params: { ...FILTERS, ...params }, status: 'green', reason: 'ok' },
    pid: null, simplified: null, dKind: 'd_max',
    motors: { satPct: 0.2, spreadPct: 5, desyncs: 0, airClips: 0, clipT: [] }, power: { resistanceMOhm: 10, rippleP99: 0.5, cells: 6 },
    setup: { dynIdle: 25, bidir: true, pidDenom: 1, idleRpm: 3200 },
    ...over,
  };
}
const find = (r: ReturnType<typeof runAdvisor>, id: string) => r.advice.find((a) => a.id === id);

afterEach(() => setBoardClass(null));

describe('динамический холостой ход', () => {
  it('выключен при bidir DShot → стартовое значение класса 5" (25 = 2500 об/мин)', () => {
    const a = find(runAdvisor(input({ setup: { dynIdle: 0, bidir: true, pidDenom: 1, idleRpm: 3200 } })), 'R-SETUP-DYN-IDLE-01')!;
    expect(a).toBeDefined();
    expect(a.changes).toEqual({ dyn_idle_min_rpm: 25 });
    expect(a.safety).toBe(false);
  });

  it('не выше 90 % оборотов статического ХХ из лога', () => {
    const a = find(runAdvisor(input({ setup: { dynIdle: 0, bidir: true, pidDenom: 1, idleRpm: 2200 } })), 'R-SETUP-DYN-IDLE-01')!;
    expect(a.changes.dyn_idle_min_rpm).toBe(19);
    expect(a.inputs.capped).toBe(1);
  });

  it('значение зависит от класса борта', () => {
    setBoardClass('7in');
    expect(find(runAdvisor(input({ setup: { dynIdle: 0, bidir: true, pidDenom: 1, idleRpm: null } })), 'R-SETUP-DYN-IDLE-01')!.changes.dyn_idle_min_rpm).toBe(18);
    setBoardClass('3in');
    expect(find(runAdvisor(input({ setup: { dynIdle: 0, bidir: true, pidDenom: 1, idleRpm: null } })), 'R-SETUP-DYN-IDLE-01')!.changes.dyn_idle_min_rpm).toBe(40);
  });

  it('нет bidir DShot или ХХ уже включён — правило молчит', () => {
    expect(find(runAdvisor(input({ setup: { dynIdle: 0, bidir: false, pidDenom: 1, idleRpm: 3000 } })), 'R-SETUP-DYN-IDLE-01')).toBeUndefined();
    expect(find(runAdvisor(input({ setup: { dynIdle: 25, bidir: true, pidDenom: 1, idleRpm: 3000 } })), 'R-SETUP-DYN-IDLE-01')).toBeUndefined();
  });

  it('CLI проходит белый список полётника', () => {
    const a = find(runAdvisor(input({ setup: { dynIdle: 0, bidir: true, pidDenom: 1, idleRpm: 3200 } })), 'R-SETUP-DYN-IDLE-01')!;
    const cli = cliDiff(a.from, a.changes, FW);
    expect(cli.lines).toEqual(['set dyn_idle_min_rpm = 25', 'save']);
    expect(cliAllowed(cli.lines[0])).toBe(true);
  });
});

describe('обязательные фильтры', () => {
  it('PID медленнее гиро и LPF2 выключен → включить LPF2 (значение по множителю Simplified)', () => {
    const r = runAdvisor(input({ setup: { dynIdle: 25, bidir: true, pidDenom: 2, idleRpm: 3000 } }, { gyro_lpf2_static_hz: 0 }));
    const a = find(r, 'R-FLT-LPF2-DENOM-01')!;
    expect(a.changes).toEqual({ gyro_lpf2_static_hz: 800 });
    expect(a.safety).toBe(false);
  });

  it('PID на частоте гиро — LPF2 можно не трогать', () => {
    expect(find(runAdvisor(input({}, { gyro_lpf2_static_hz: 0 })), 'R-FLT-LPF2-DENOM-01')).toBeUndefined();
  });

  it('все фильтры D-term выключены → включить D-term LPF1 (красный)', () => {
    const r = runAdvisor(input({}, { dterm_lpf1_static_hz: 0, dterm_lpf2_static_hz: 0 }));
    const a = find(r, 'R-FLT-DTERM-OFF-01')!;
    expect(a.severity).toBe('red');
    expect(a.changes).toEqual({ dterm_lpf1_static_hz: 105 });
  });

  it('хотя бы один фильтр D-term есть — правило молчит', () => {
    expect(find(runAdvisor(input({}, { dterm_lpf1_static_hz: 0 })), 'R-FLT-DTERM-OFF-01')).toBeUndefined();
  });
});

describe('разбор экспорта чата: газ, срезы, задержка, bidir, 1–2S', () => {
  it('лог без верхов газа: подсказка, и ослаблять фильтры по нему нельзя', () => {
    const clean = input({ noise: { unfilt: [6, 5, 4], filt: [0.5, 0.5, 0.5], dterm: [2, 2, null], peaks: [] } });
    expect(find(runAdvisor(clean), 'R-FLT-GYRO-RAISE-01')).toBeDefined();
    const low = runAdvisor({ ...clean, flight: { thrTop: 45, gyroDelayMs: 1 } });
    expect(find(low, 'R-LOG-THROTTLE-01')!.inputs.top).toBe(45);
    expect(find(low, 'R-FLT-GYRO-RAISE-01')).toBeUndefined();
    expect(find(low, 'R-FLT-DTERM-RAISE-01')).toBeUndefined();
    expect(find(runAdvisor({ ...clean, flight: { thrTop: 95, gyroDelayMs: 1 } }), 'R-LOG-THROTTLE-01')).toBeUndefined();
  });

  it('срез гиро ниже 100 Гц на 5" → поднять до 100 (рискованное изменение)', () => {
    const a = find(runAdvisor(input({}, { simplified_gyro_filter: 0, gyro_lpf1_static_hz: 70, gyro_lpf2_static_hz: 500 })), 'R-FLT-LOWCUT-01')!;
    expect(a.changes).toEqual({ gyro_lpf1_static_hz: 100 });
    expect(a.safety).toBe(true);
    setBoardClass('10in');
    expect(find(runAdvisor(input({}, { simplified_gyro_filter: 0, gyro_lpf1_static_hz: 70 })), 'R-FLT-LOWCUT-01')).toBeUndefined();
  });

  it('задержка гиро выше ориентира класса — только сведения', () => {
    const a = find(runAdvisor(input({ flight: { thrTop: 100, gyroDelayMs: 2.6 } })), 'R-FLT-DELAY-01')!;
    expect(a.kind).toBe('info');
    expect(a.inputs.target).toBe(2);
    setBoardClass('3in');
    expect(find(runAdvisor(input({ flight: { thrTop: 100, gyroDelayMs: 1.9 } })), 'R-FLT-DELAY-01')!.inputs.target).toBe(1.75);
    setBoardClass('10in');
    expect(find(runAdvisor(input({ flight: { thrTop: 100, gyroDelayMs: 2.6 } })), 'R-FLT-DELAY-01')).toBeUndefined();
  });

  it('bidir DShot выключен → подсказка; неизвестно (нет в заголовке) → молчим', () => {
    expect(find(runAdvisor(input({ setup: { dynIdle: 0, bidir: false, pidDenom: 1, idleRpm: null } })), 'R-SETUP-BIDIR-01')).toBeDefined();
    expect(find(runAdvisor(input({ setup: { dynIdle: 0, bidir: null, pidDenom: 1, idleRpm: null } })), 'R-SETUP-BIDIR-01')).toBeUndefined();
  });

  it('на 1–2S динамический ХХ не советуем', () => {
    const off = { setup: { dynIdle: 0, bidir: true, pidDenom: 1, idleRpm: 9000 } };
    expect(find(runAdvisor(input({ ...off, power: { resistanceMOhm: 10, rippleP99: 0.5, cells: 1 } })), 'R-SETUP-DYN-IDLE-01')).toBeUndefined();
    expect(find(runAdvisor(input({ ...off, power: { resistanceMOhm: 10, rippleP99: 0.5, cells: 4 } })), 'R-SETUP-DYN-IDLE-01')).toBeDefined();
  });

  it('нет срезов D-term в заголовке (старый лог) — «D-term выключен» не срабатывает', () => {
    const r = runAdvisor(input({ filters: { params: { dyn_notch_count: 1, dyn_notch_min_hz: 100, dyn_notch_max_hz: 400 }, status: 'red', reason: 'old-fw' } }));
    expect(find(r, 'R-FLT-DTERM-OFF-01')).toBeUndefined();
    expect(find(r, 'R-FLT-LPF2-DENOM-01')).toBeUndefined();
  });
});

describe('тест моторов на столе (MOTOR_TEST)', () => {
  it('стендовый лог: полётные правила молчат, есть подсказка про тест', () => {
    const r = runAdvisor(input({ motors: { satPct: 40, spreadPct: 35, desyncs: 0, airClips: 0, clipT: [] }, flight: { thrTop: 0, gyroDelayMs: 3, bench: true } }));
    expect(r.advice.map((a) => a.id)).toEqual(['R-LOG-BENCH-01']);
  });

  it('распознаётся по «моторы крутятся, газ на нуле»', () => {
    const n = 20000, fs = 2000;
    const mk = (thr: number, mot: number) => ({ n, fs, thrPct: new Float32Array(n).fill(thr), motorAvg: new Float32Array(n).fill(mot) }) as any;
    expect(isBenchTest(mk(0, 0.4))).toBe(true);
    expect(isBenchTest(mk(45, 0.4))).toBe(false);
    expect(isBenchTest(mk(0, 0))).toBe(false);
  });
});

describe.skipIf(!hasFixture(SMALL_DUMP) || !hasFixture(BIG_DUMP))('на логах пользователя', () => {
  it('2026.6.1 №4: дин. ХХ выключен — совет есть, но отложен до механики (срывы)', () => {
    const c = buildContext(decodeLog(readRange(SMALL_DUMP, 1040384, 2129920)));
    const a = analyzeLog(c);
    expect(a.h.motors.idleRpm).not.toBeNull();
    expect(a.h.motors.idleRpm!).toBeGreaterThan(1000);
    expect(a.h.motors.idleRpm!).toBeLessThan(8000);
    const r = adviseLog(a);
    const d = r.advice.find((x) => x.id === 'R-SETUP-DYN-IDLE-01')!;
    expect(d).toBeDefined();
    expect(d.deferred).toBe('mechanics-first');
    expect(d.changes.dyn_idle_min_rpm).toBeLessThanOrEqual(Math.floor((a.h.motors.idleRpm! * 0.9) / 100));
  });

  it('4.5.2: PID 4 кГц при гиро 8 кГц, но LPF2 включён (800 Гц) — правило LPF2 молчит', () => {
    const c = buildContext(decodeLog(readRange(BIG_DUMP, 63977472, 933888)));
    expect(setupFromHeader(c.log.header, null)!.pidDenom).toBe(2);
    const r = adviseLog(analyzeLog(c));
    expect(r.advice.map((x) => x.id)).not.toContain('R-FLT-LPF2-DENOM-01');
    expect(r.advice.map((x) => x.id)).not.toContain('R-FLT-DTERM-OFF-01');
  });
});
