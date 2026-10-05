// Классы бортов (E2.2): профиль из старого текста, переопределение порогов по классу меняет
// светофор и советчик, возврат к 5" — полностью, неоткалиброванный класс помечен.
import { afterEach, describe, expect, it } from 'vitest';
import cfg from '../src/config/analysis.json';
import { CLASSES, activeClass, classInfo, setBoardClass } from '../src/config/classes';
import { guessClass, normalizeProfile } from '../src/sessions/profile';
import { runAdvisor, type AdvisorInput } from '../src/advisor/advisor';
import { buildContext } from '../src/analysis/context';
import { adviseLog, analyzeLog } from '../src/analysis/pipeline';
import { decodeLog } from '../src/decoder/decoder';
import { scanFile } from '../src/decoder/scan';
import { comparability } from '../src/sessions/compare';
import { SMALL_DUMP, fileReader, hasFixture, readRange } from './helpers';

const list = cfg.classes.list as unknown as Record<string, { calibrated: boolean; overrides: Record<string, unknown> }>;

afterEach(() => {
  list['7in'].overrides = {};
  setBoardClass('5in');
});

describe('профиль борта', () => {
  it('класс из старого текста и числа из полей', () => {
    expect(guessClass('5"')).toBe('5in');
    expect(guessClass('7 дюймов')).toBe('7in');
    expect(guessClass('65мм')).toBe('65mm');
    expect(guessClass('85 mm')).toBe('85mm');
    expect(guessClass('3.5"')).toBe('3in');
    expect(guessClass('шнурок')).toBeUndefined();
    expect(normalizeProfile({ props: 'HQ 5.1" 6S', kv: '1950KV', weight: '650 г' })).toMatchObject({ cls: '5in', kvRating: 1950, weightG: 650, cells: 6, props: 'HQ 5.1" 6S' });
    expect(normalizeProfile({ cls: '7in', props: '5"' }).cls).toBe('7in');
  });

  it('классы: 5" откалиброван, остальные — «по аналогии с 5"»', () => {
    expect(CLASSES).toEqual(['65mm', '85mm', '3in', '5in', '7in', '10in']);
    expect(classInfo('5in')).toMatchObject({ calibrated: true, like: null });
    expect(classInfo('7in')).toMatchObject({ calibrated: false, like: '5in' });
    expect(classInfo('нет такого').cls).toBe('5in');
  });
});

describe('переопределение порогов по классу', () => {
  it('советчик: D-term 23 горячий для 5", но не для 7" с порогом 30; 5" восстанавливается', () => {
    const FW = 2_026_006_001;
    const inp: AdvisorInput = {
      fwCode: FW, logHz: 2000, hasUnfilt: true,
      noise: { unfilt: [6, 5, 4], filt: [0.5, 0.4, 0.3], dterm: [23, 9, null], peaks: [] },
      filters: { params: { simplified_dterm_filter: 1, simplified_dterm_filter_multiplier: 100, dterm_lpf1_dyn_min_hz: 75, dterm_lpf1_dyn_max_hz: 150, dterm_lpf1_static_hz: 75, dterm_lpf2_static_hz: 150 }, status: 'green', reason: 'ok' },
      pid: null, simplified: null, dKind: 'd_max',
      motors: { satPct: 0.2, spreadPct: 5, desyncs: 0, airClips: 0, clipT: [] }, power: { resistanceMOhm: 10, rippleP99: 0.5, cells: 6 },
    } as unknown as AdvisorInput;
    const hot = (): boolean => runAdvisor(structuredClone(inp)).advice.some((a) => a.id === 'R-FLT-DTERM-HOT-01');
    expect(hot()).toBe(true);
    list['7in'].overrides = { advisor: { dtermRms: { red: 30 } } };
    const info = setBoardClass('7in');
    expect(info.overridden).toEqual(['advisor.dtermRms.red']);
    expect(activeClass()).toBe('7in');
    expect(cfg.advisor.dtermRms.red).toBe(30);
    expect(hot()).toBe(false);
    setBoardClass('5in');
    expect(cfg.advisor.dtermRms.red).toBe(20);
    expect(hot()).toBe(true);
  });

  it('кэшированный раздел (const C = cfg.compare) видит переопределение — правка на месте', async () => {
    const snap = (s: number) => ({ source: { firmware: 'x', craft: 'c', board: 'b', fs: 2000 }, flight: { seconds: s, thrHist: [50, 50], stickRms: [100, 100, 50], cellV: 3.9 }, noise: { thr: { pct: [], seconds: [] } } });
    // 8 с полёта — короче 10 с: красный; класс с minFlightS 5 — уже нет
    expect(comparability(snap(30) as never, snap(8) as never).warnings).toContain('short');
    list['7in'].overrides = { compare: { minFlightS: 5 } };
    setBoardClass('7in');
    expect(comparability(snap(30) as never, snap(8) as never).warnings).not.toContain('short');
  });

  it.skipIf(!hasFixture(SMALL_DUMP))('светофор на логе 2026.6.1 №4: шум после фильтров зелёный, с порогами класса — нет; класс в советах и снимке', async () => {
    const r = fileReader(SMALL_DUMP);
    const st = await scanFile(r);
    r.close();
    const L = st.logs.find((l) => l.index === 4)!;
    const buf = readRange(SMALL_DUMP, L.start, L.end - L.start);
    const card = (): string => {
      const a = analyzeLog(buildContext(decodeLog(buf)));
      return a.cards.find((c) => c.id === 'noise')!.metrics.find((m) => /после/i.test(m.label))?.status ?? a.cards.find((c) => c.id === 'noise')!.status;
    };
    expect(card()).toBe('green');
    list['7in'].overrides = { noise: { filtRms: { green: 0.1, red: 0.2 } } };
    setBoardClass('7in');
    expect(card()).toBe('red');
    const a = analyzeLog(buildContext(decodeLog(buf)));
    expect(adviseLog(a).cls).toMatchObject({ cls: '7in', calibrated: false, like: '5in' });
    setBoardClass('5in');
    expect(card()).toBe('green');
  });
});
