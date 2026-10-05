// Этап 3: рейты. Формулы — против значений, которые показывает Betaflight Configurator
// (вкладка Rates, превью кривой / Max Vel) для каждого rates_type, и против записанного
// setpoint на настоящих логах.
import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/analysis/context';
import { buildFlightMask } from '../src/analysis/flightMask';
import { col, decodeLog } from '../src/decoder/decoder';
import { scanFile } from '../src/decoder/scan';
import { cliDiff } from '../src/params/registry';
import { buildRatesBase, evalRates, newSetpoint } from '../src/rates/analyze';
import {
  AxisRates, RATES_TYPE, RateProfile, applyRates, centerSensitivity, cloneProfile, convertProfile, maxRate, profileToCli,
  ratesFromHeader, setpointFor,
} from '../src/rates/rates';
import { BIG_DUMP, SMALL_DUMP, fileReader, hasFixture, readRange } from './helpers';

const HAS_SMALL = hasFixture(SMALL_DUMP);
const HAS_BIG = hasFixture(BIG_DUMP);

const ax = (rcRate: number, rate: number, expo: number, limit = 1998): AxisRates => ({ rcRate, rate, expo, limit });
const prof = (type: number, a: AxisRates, quickRcExpo = 0): RateProfile => ({ type, axes: [a, { ...a }, { ...a }], quickRcExpo, deadband: 0, yawDeadband: 0 });

describe('формулы рейтов (rc.c) против значений конфигуратора', () => {
  // [тип, параметры, отклонение стика, ожидаемые °/с]
  const cases: [string, number, AxisRates, number, number, number?][] = [
    ['BF: RC Rate 1.00, Super 0.70 → max 667', RATES_TYPE.BETAFLIGHT, ax(100, 70, 0), 1, 666.67],
    ['BF: RC Rate 1.00, Super 0 → 200 на полном стике', RATES_TYPE.BETAFLIGHT, ax(100, 0, 0), 1, 200],
    ['BF: RC Rate 2.50 (выше 2.0 — ускоренный рост) → 1954', RATES_TYPE.BETAFLIGHT, ax(250, 0, 0), 1, 1954],
    ['BF: expo не меняет max', RATES_TYPE.BETAFLIGHT, ax(100, 70, 50), 1, 666.67],
    ['BF: половина стика, RC 1.0, Super 0.7, expo 0', RATES_TYPE.BETAFLIGHT, ax(100, 70, 0), 0.5, 153.85],
    ['Actual: дефолт 70/670/0 → max 670', RATES_TYPE.ACTUAL, ax(7, 67, 0), 1, 670],
    ['Actual: дефолт на половине стика → 185', RATES_TYPE.ACTUAL, ax(7, 67, 0), 0.5, 185],
    ['Actual: 20/800/0.40 на половине стика', RATES_TYPE.ACTUAL, ax(2, 80, 40), 0.5, 10 + 780 * 0.5 * (0.5 ** 5 * 0.4 + 0.5 * 0.6)],
    ['Actual: max < центра → прямая', RATES_TYPE.ACTUAL, ax(50, 20, 0), 1, 500],
    ['Quick: RC 1.00, max 670, expo 0 → 670', RATES_TYPE.QUICK, ax(100, 67, 0), 1, 670],
    ['Quick: на половине стика → 154', RATES_TYPE.QUICK, ax(100, 67, 0), 0.5, 154.02],
    ['Quick (rc expo ON): max не меняется', RATES_TYPE.QUICK, ax(100, 67, 50), 1, 670, 1],
    ['Kiss: RC Rate 1.00, Rate 0.70 → 667', RATES_TYPE.KISS, ax(100, 70, 0), 1, 666.67],
    ['Kiss: упор в 1998', RATES_TYPE.KISS, ax(255, 99, 0), 1, 1998],
    ['Raceflight: 370 °/с, Acro+ 80 % → 666', RATES_TYPE.RACEFLIGHT, ax(37, 80, 0), 1, 666],
    ['Raceflight: expo не меняет max', RATES_TYPE.RACEFLIGHT, ax(37, 80, 50), 1, 666],
  ];
  for (const [name, type, a, d, want, q] of cases) {
    it(name, () => {
      expect(setpointFor(prof(type, a, q ?? 0), 0, d)).toBeCloseTo(want, 1);
    });
  }

  it('rate_limit срезает кривую', () => {
    expect(setpointFor(prof(RATES_TYPE.ACTUAL, ax(7, 120, 0, 800)), 0, 1)).toBe(800);
  });

  it('все типы: нечётная функция, монотонная, 0 в центре', () => {
    const sets: [number, AxisRates][] = [
      [RATES_TYPE.BETAFLIGHT, ax(120, 75, 30)], [RATES_TYPE.RACEFLIGHT, ax(40, 60, 30)], [RATES_TYPE.KISS, ax(110, 65, 40)],
      [RATES_TYPE.ACTUAL, ax(15, 85, 50)], [RATES_TYPE.QUICK, ax(110, 80, 40)],
    ];
    for (const [t, a] of sets) {
      expect(applyRates(t, a, 0)).toBe(0);
      let prev = -Infinity;
      for (let d = -1; d <= 1.0001; d += 0.02) {
        const v = applyRates(t, a, d);
        expect(v).toBeCloseTo(-applyRates(t, a, -d), 6);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = v;
      }
    }
  });

  it('Actual: чувствительность в центре = rc_rate × 10', () => {
    expect(centerSensitivity(prof(RATES_TYPE.ACTUAL, ax(7, 67, 54)), 0)).toBeCloseTo(70, 0);
  });

  it('перевод Actual → Betaflight → Actual: max rate сохраняется', () => {
    const p = prof(RATES_TYPE.ACTUAL, ax(7, 67, 0));
    const bf = convertProfile(p, RATES_TYPE.BETAFLIGHT);
    expect(bf.profile.type).toBe(RATES_TYPE.BETAFLIGHT);
    // max rate держится почти жёстко, форма — приблизительно (семейства кривых разные)
    expect(Math.abs(maxRate(bf.profile, 0) - 670)).toBeLessThan(10);
    expect(bf.rmsErr[0]).toBeLessThan(45);
    // Actual с expo → Betaflight повторяется хорошо
    const pe = prof(RATES_TYPE.ACTUAL, ax(7, 67, 54));
    expect(convertProfile(pe, RATES_TYPE.BETAFLIGHT).rmsErr[0]).toBeLessThan(10);
    const back = convertProfile(bf.profile, RATES_TYPE.ACTUAL);
    expect(Math.abs(maxRate(back.profile, 0) - maxRate(bf.profile, 0))).toBeLessThan(15);
  });

  it('CLI: тип рейтов словом, имена как в settings.c', () => {
    const a = prof(RATES_TYPE.ACTUAL, ax(7, 67, 0));
    const b = cloneProfile(a);
    b.type = RATES_TYPE.BETAFLIGHT;
    b.axes[0].rate = 70;
    const r = cliDiff(profileToCli(a), profileToCli(b), 2_026_006_001);
    expect(r.lines).toEqual(['set rates_type = BETAFLIGHT', 'set roll_srate = 70', 'save']);
    // перечисления фильтров — тоже словом (BF CLI не принимает число)
    expect(cliDiff({ gyro_lpf1_type: 0, simplified_gyro_filter: 1 }, { gyro_lpf1_type: 3, simplified_gyro_filter: 0 }, 2_026_006_001).lines)
      .toEqual(['set gyro_lpf1_type = PT3', 'set simplified_gyro_filter = OFF', 'save']);
    // за пределы диапазона не выходим
    const c = cloneProfile(a);
    c.axes[2].rate = 400;
    expect(cliDiff(profileToCli(a), profileToCli(c), 2_026_006_001).lines[0]).toBe('set yaw_srate = 255');
  });
});

async function openLog(file: string, index: number) {
  const r = fileReader(file);
  const st = await scanFile(r);
  r.close();
  const L = st.logs.find((l) => l.index === index)!;
  const end = L.crossesWrap && L.wrapBoundary ? L.wrapBoundary : L.end;
  const log = decodeLog(readRange(file, L.start, end - L.start));
  const c = buildContext(log);
  return { c, fm: buildFlightMask(c) };
}

describe.skipIf(!HAS_SMALL)('рейты на логе 2026.6.1 №4', () => {
  it('заголовок: Actual 70/670/0; формула даёт записанный setpoint', async () => {
    const { c, fm } = await openLog(SMALL_DUMP, 4);
    const p = ratesFromHeader(c.log.header)!;
    expect(p.type).toBe(RATES_TYPE.ACTUAL);
    expect(maxRate(p, 0)).toBe(670);
    const w = buildRatesBase(c, fm.mask, p);
    expect(w.base.check.status).toBe('green');
    expect(w.base.smoothHz).toBe(56);
    for (const a of w.base.check.axes) {
      expect(a.samples).toBeGreaterThan(250);
      expect(a.matchPct).toBeGreaterThanOrEqual(99);
      expect(a.rmsErr).toBeLessThan(0.6); // ≈ округление лога
    }
    // гистограммы — доли времени, в сумме 100 %
    for (const hgram of [...w.base.hist.axes, w.base.hist.throttle]) expect(hgram.reduce((s, x) => s + x, 0)).toBeCloseTo(100, 3);
  });

  it('те же рейты → новый setpoint совпадает с записанным', async () => {
    const { c, fm } = await openLog(SMALL_DUMP, 4);
    const p = ratesFromHeader(c.log.header)!;
    const w = buildRatesBase(c, fm.mask, p);
    const sp = newSetpoint(c, w, cloneProfile(p));
    const logged = col(c.log, 'setpoint[0]')!;
    let mx = 0;
    for (let i = 0; i < c.n; i++) mx = Math.max(mx, Math.abs(sp[0][i] - logged[i]));
    expect(mx).toBeLessThan(1e-3);
  });
});

describe.skipIf(!HAS_BIG)('рейты на логах 4.5.2', () => {
  it('№0: GPS Rescue исключён (бит 7 в 4.5.2; раньше ошибочно назывался HEADFREE), формула совпадает', async () => {
    const { c, fm } = await openLog(BIG_DUMP, 0);
    const w = buildRatesBase(c, fm.mask, ratesFromHeader(c.log.header)!);
    expect(w.base.check.status).toBe('green');
    expect(w.base.check.nonRateModes).toEqual(['GPSRESCUE']);
    expect(w.base.check.nonRateS).toBeGreaterThan(5);
  });

  it('№3: флипы найдены, «на этом флипе было бы»', async () => {
    const { c, fm } = await openLog(BIG_DUMP, 3);
    const p = ratesFromHeader(c.log.header)!;
    expect(maxRate(p, 0)).toBe(800);
    const w = buildRatesBase(c, fm.mask, p);
    expect(w.base.check.status).toBe('green');
    const M = w.base.maneuvers;
    expect(M.length).toBeGreaterThanOrEqual(5);
    const full = M.filter((m) => Math.abs(m.spWas) >= 790);
    expect(full.length).toBeGreaterThanOrEqual(3);
    // флипы ~360°: угол по setpoint и по гироскопу близки
    for (const m of full) {
      expect(Math.abs(m.angleWas)).toBeGreaterThan(250);
      expect(Math.abs(m.angleGyro - m.angleWas)).toBeLessThan(40);
    }
    const q = cloneProfile(p);
    q.axes.forEach((a) => { a.rate = 100; });
    const ev = evalRates(c, w, newSetpoint(c, w, q));
    full.forEach((m) => {
      const i = M.indexOf(m);
      expect(Math.abs(ev.maneuvers[i].spNew)).toBeGreaterThan(990);
      expect(Math.abs(ev.maneuvers[i].angleNew)).toBeGreaterThan(Math.abs(m.angleWas) * 1.15);
    });
  });
});
