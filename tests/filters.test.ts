// Этап 2: модель фильтров Betaflight.
import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/analysis/context';
import { buildFlightMask } from '../src/analysis/flightMask';
import { analyzeNoise } from '../src/analysis/noise';
import { decodeLog } from '../src/decoder/decoder';
import { buildBaseline, evaluate } from '../src/filters/evaluate';
import { Biquad, BIQUAD, Lowpass, LPF_TYPE, dynLpfCutoff, pt1FilterGain } from '../src/filters/primitives';
import { applySimplified, cliDiff, contextFromHeader, paramsFromHeader, simplifiedConsistent } from '../src/filters/settings';
import { BIG_DUMP, SMALL_DUMP, hasFixture, readRange } from './helpers';

const HAS_SMALL = hasFixture(SMALL_DUMP);
const HAS_BIG = hasFixture(BIG_DUMP);

/** амплитуда и фаза выхода на синус — сравниваем с response() */
function measure(f: { apply(x: number): number }, hz: number, fs: number): [number, number] {
  const n = Math.round(fs * 2);
  let re = 0, im = 0;
  for (let i = 0; i < n; i++) {
    const y = f.apply(Math.sin((2 * Math.PI * hz * i) / fs));
    if (i >= n / 2) { re += y * Math.sin((2 * Math.PI * hz * i) / fs); im += y * Math.cos((2 * Math.PI * hz * i) / fs); }
  }
  return [(re * 2) / (n / 2), (im * 2) / (n / 2)];
}

describe('примитивы фильтров', () => {
  const fs = 8000, dT = 1 / fs;
  for (const [name, mk] of [
    ['PT1 100', () => new Lowpass(LPF_TYPE.PT1, 100, 125)],
    ['PT2 200', () => new Lowpass(LPF_TYPE.PT2, 200, 125)],
    ['PT3 300', () => new Lowpass(LPF_TYPE.PT3, 300, 125)],
    ['BIQUAD 250', () => new Lowpass(LPF_TYPE.BIQUAD, 250, 125)],
    ['notch 300 Q5 вес 0.7', () => { const b = new Biquad(true); b.update(300, 125, 5, BIQUAD.NOTCH, 0.7); return b; }],
  ] as const) {
    it(`${name}: response() совпадает с прогоном синуса`, () => {
      for (const hz of [37, 120, 290, 650]) {
        const f = mk();
        const [a, b] = measure(f, hz, fs);
        const [hr, hi] = mk().response(hz, dT);
        expect(Math.abs(Math.hypot(a, b) - Math.hypot(hr, hi))).toBeLessThan(0.01);
      }
    });
  }
  it('PT2/PT3: поправка среза BF даёт ≈ −3 дБ (в дискретном виде −3…−4 дБ, как в прошивке)', () => {
    for (const t of [LPF_TYPE.PT2, LPF_TYPE.PT3]) {
      const [hr, hi] = new Lowpass(t, 200, 125).response(200, 125e-6);
      const db = 20 * Math.log10(Math.hypot(hr, hi));
      expect(db).toBeLessThan(-2.9);
      expect(db).toBeGreaterThan(-4.2);
    }
  });
  it('pt1FilterGain как в BF', () => {
    expect(pt1FilterGain(100, 125e-6)).toBeCloseTo((2 * Math.PI * 100 * 125e-6) / (2 * Math.PI * 100 * 125e-6 + 1), 12);
  });
  it('кривая dyn LPF: края и экспо', () => {
    expect(dynLpfCutoff(0, 250, 500, 5)).toBe(250);
    expect(dynLpfCutoff(1, 250, 500, 5)).toBe(500);
    expect(dynLpfCutoff(0.5, 250, 500, 5)).toBeCloseTo(250 + 250 * (0.5 * 0.5 * 0.5 + 0.5), 6);
  });
});

describe('Simplified Tuning и CLI', () => {
  it('множители из CLI-бэкапа пользователя дают его значения', () => {
    // gyro ×160: lpf1 выключен, lpf2 = 500·1.6 = 800; dterm ×140: 75·1.4 = 105, 150·1.4 = 210
    const p = applySimplified({
      simplified_gyro_filter: 1, simplified_gyro_filter_multiplier: 160, gyro_lpf1_static_hz: 0, gyro_lpf1_dyn_min_hz: 0, gyro_lpf2_static_hz: 500,
      simplified_dterm_filter: 1, simplified_dterm_filter_multiplier: 140, dterm_lpf1_static_hz: 75, dterm_lpf1_dyn_min_hz: 0, dterm_lpf2_static_hz: 150,
    });
    expect(p.gyro_lpf2_static_hz).toBe(800);
    expect(p.gyro_lpf1_static_hz).toBe(0);
    expect(p.dterm_lpf1_static_hz).toBe(105);
    expect(p.dterm_lpf2_static_hz).toBe(210);
  });
  it.skipIf(!HAS_BIG)('заголовок 4.5.2 согласован с simplified', () => {
    const log = decodeLog(readRange(BIG_DUMP, 63977472, 933888));
    expect(simplifiedConsistent(paramsFromHeader(log.header))).toEqual({ gyro: true, dterm: true });
  });
  it('CLI: только изменённое, с зажимом в диапазон', () => {
    const r = cliDiff({ gyro_lpf2_static_hz: 500, dyn_notch_q: 300 }, { gyro_lpf2_static_hz: 1500, dyn_notch_q: 300 }, 2_026_006_001);
    expect(r.lines).toEqual(['set gyro_lpf2_static_hz = 1000', 'save']);
  });
});

function setup(file: string, start: number, len: number) {
  const log = decodeLog(readRange(file, start, len));
  const ctx = buildContext(log);
  const fm = buildFlightMask(ctx);
  const nz = analyzeNoise(ctx, fm);
  const p = paramsFromHeader(log.header);
  const fc = contextFromHeader(log.header, ctx.fw.code);
  return { log, ctx, fm, nz, p, fc };
}

describe('самопроверка модели на настоящих логах', () => {
  it.skipIf(!HAS_SMALL)('2026.6.1, 2 кГц: модель совпадает с бортом ≥ 90 % по всем осям, D-term корреляция ≥ 0.9', () => {
    const s = setup(SMALL_DUMP, 1040384, 2129920);
    const { base } = buildBaseline(s.ctx, s.fm.mask, s.nz.bursts, s.p, s.fc);
    const v = base.validation;
    console.log('2026 match', v.match.map((x) => x.toFixed(1)), 'spec dB', v.spectralDb.map((x) => x.toFixed(2)), 'Dcorr', v.dCorr, 'Dgain', v.dGain);
    expect(v.status).toBe('green');
    for (const m of v.match) expect(m).toBeGreaterThanOrEqual(90);
    for (const c of v.dCorr) expect(c!).toBeGreaterThan(0.9);
    for (const d of v.spectralDb) expect(d).toBeLessThan(2.0);
  });
  it.skipIf(!HAS_BIG)('4.5.2, 1 кГц: модель честно не зелёная из-за низкой частоты лога', () => {
    const s = setup(BIG_DUMP, 63977472, 933888);
    const { base } = buildBaseline(s.ctx, s.fm.mask, s.nz.bursts, s.p, s.fc);
    const v = base.validation;
    console.log('4.5.2 match', v.match.map((x) => x.toFixed(1)), 'spec dB', v.spectralDb.map((x) => x.toFixed(2)), 'Dcorr', v.dCorr);
    expect(v.status).not.toBe('green');
    expect(v.reason).toBe('low-rate');
    expect(v.match[2]).toBeGreaterThan(60);
  });
  it.skipIf(!HAS_SMALL)('ослабление фильтров уменьшает задержку и пропускает больше шума', () => {
    const s = setup(SMALL_DUMP, 1040384, 2129920);
    const { base } = buildBaseline(s.ctx, s.fm.mask, s.nz.bursts, s.p, s.fc);
    const weaker = applySimplified({ ...s.p, simplified_gyro_filter_multiplier: 150 });
    const { ev } = evaluate(s.ctx, weaker, s.fc, base.segments, base.n, base.current.op);
    expect(ev.delay.gyro['100']).toBeLessThan(base.current.delay.gyro['100']);
    expect(ev.rmsGyro[0]).toBeGreaterThan(base.current.rmsGyro[0]);
    console.log('delay100', base.current.delay.gyro['100'].toFixed(3), '→', ev.delay.gyro['100'].toFixed(3), 'ms; rms', base.current.rmsGyro[0].toFixed(3), '→', ev.rmsGyro[0].toFixed(3), 'sim ms', ev.ms.toFixed(0));
  });
});
