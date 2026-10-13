// Автотюн: политика «не душить» поверх правил советчика, пропы, откат, вердикт по полёту.
// Синтетика (подставные цифры, как в advisor.test.ts) + настоящие логи тем же путём, что воркер.
import { describe, expect, it } from 'vitest';
import cfg from '../src/config/analysis.json';
import { AdvisorInput, BoardKnowledge, runAdvisor } from '../src/advisor/advisor';
import { AutotuneCheckin, AutotuneCtx, revertFor, revertedRules, unfiltJump } from '../src/autotune/autotune';
import { buildContext } from '../src/analysis/context';
import { adviseLog, analyzeLog, snapshotLog } from '../src/analysis/pipeline';
import { decodeLog } from '../src/decoder/decoder';
import { scanFile } from '../src/decoder/scan';
import { T } from '../src/i18n/ru';
import type { PidResult } from '../src/pid/analyze';
import { SNAPSHOT_VERSION, type SessionSnapshot } from '../src/sessions/snapshot';
import { BIG_DUMP, SMALL_DUMP, fileReader, hasFixture, readRange } from './helpers';

const FW = 2_026_006_001;
const FILTERS = { simplified_gyro_filter: 1, simplified_gyro_filter_multiplier: 100, gyro_lpf1_dyn_min_hz: 250, gyro_lpf1_dyn_max_hz: 500, gyro_lpf1_static_hz: 250, gyro_lpf2_static_hz: 500, simplified_dterm_filter: 1, simplified_dterm_filter_multiplier: 100, dterm_lpf1_dyn_min_hz: 75, dterm_lpf1_dyn_max_hz: 150, dterm_lpf1_static_hz: 75, dterm_lpf2_static_hz: 150, dyn_notch_count: 3, dyn_notch_min_hz: 150, dyn_notch_max_hz: 600 };
const SIMPL = { s: { mode: 2, master: 100, pi: 100, i: 100, d: 100, dExtra: 100, ff: 100, pitchD: 100, pitchPi: 100 }, dExtraName: 'simplified_d_max_gain' };

function pidWith(os: number, settle = 1, enough = true, delay = 12): PidResult {
  const ax = (axis: number) => ({
    axis, step: { t: new Float32Array(1), mean: new Float32Array(1), std: new Float32Array(1), parts: [], activeS: enough ? 60 : 5, usedS: 60 },
    metrics: { overshootPct: os, peak: 1 + os / 100, peakMs: 40, delayMs: delay, riseMs: 15, settle }, enough, stdAtPeak: 0.02,
    trackRms: 5, spRms: 50, contrib: { P: 10, I: 10, D: 10, F: 5 }, ffJitter: 0.2,
  });
  return { axes: [ax(0), ax(1), ax(2)], gains: { P: [45, 47, 45], I: [80, 84, 80], D: [30, 34, 0], F: [120, 125, 120], dExtra: [40, 46, 0], dExtraKind: 'd_max' }, seconds: 60, satS: 0 };
}

function input(over: Partial<AdvisorInput> = {}, noise: Partial<NonNullable<AdvisorInput['noise']>> = {}): AdvisorInput {
  return {
    fwCode: FW, logHz: 2000, hasUnfilt: true,
    noise: { unfilt: [6, 5, 4], filt: [0.5, 0.4, 0.3], dterm: [3, 2, null], peaks: [], ...noise },
    filters: { params: { ...FILTERS }, status: 'green', reason: 'ok' },
    pid: pidWith(5), simplified: SIMPL, dKind: 'd_max',
    motors: { satPct: 0.2, spreadPct: 5, desyncs: 0, airClips: 0, clipT: [] }, power: { resistanceMOhm: 10, rippleP99: 0.5, cells: 6 },
    ...over,
  };
}
const ck = (o: Partial<AutotuneCheckin> = {}): AutotuneCheckin => ({ props: 'ok', motorTemp: 1, feel: [], ...o });
const at = (o: Partial<AutotuneCtx> = {}, c: Partial<AutotuneCheckin> = {}): { board: BoardKnowledge } => ({ board: { autotune: { checkin: ck(c), baseline: { ...FILTERS }, iteration: 2, ...o } } });
const sel = (r: ReturnType<typeof runAdvisor>) => r.advice.filter((a) => a.kind === 'tune' && a.selected).map((a) => a.id);
const why = (r: ReturnType<typeof runAdvisor>, id: string) => r.advice.find((a) => a.id === id)?.deferred;
// D-term горячий (красный) — советчик без автотюна зажал бы фильтр D-term
const HOT_DTERM = { dterm: [25, 20, null] as (number | null)[] };

describe('автотюн: «не душить»', () => {
  it('без автотюна советчик прежний (D-term красный → зажать фильтр)', () => {
    const r = runAdvisor(input({}, HOT_DTERM));
    expect(sel(r)).toContain('R-FLT-DTERM-HOT-01');
    expect(r.autotune).toBeUndefined();
  });

  it('D-term красный, но моторы тёплые → фильтры не зажимаем (не душим)', () => {
    const r = runAdvisor(input(at({}, { motorTemp: 1 }), HOT_DTERM));
    expect(sel(r)).toEqual([]);
    expect(why(r, 'R-FLT-DTERM-HOT-01')).toBe('not-hot');
    expect(r.autotune!.verdict).toBe('done');
    expect(Object.keys(r.to)).toEqual([]);
  });

  it('моторы горячие, пропы целые → зажимаем, но одно изменение за полёт', () => {
    const r = runAdvisor(input(at({}, { motorTemp: 3 }), { ...HOT_DTERM, filt: [cfg.noise.filtRms.red + 1, 1, 1] }));
    expect(sel(r)).toEqual(['R-FLT-DTERM-HOT-01']);
    expect(why(r, 'R-FLT-GYRO-NOISY-01')).toBe('max-changes');
    expect(r.to.simplified_dterm_filter_multiplier).toBe(90);
    expect(r.autotune!.verdict).toBe('tune');
  });

  it('пол «не душить»: ниже стартовых настроек серии больше чем на 15 % — нельзя', () => {
    // старт серии ×1.10, сейчас ×1.00 → шаг до ×0.90 = 82 % от старта
    const base = { ...FILTERS, simplified_dterm_filter_multiplier: 110 };
    const r = runAdvisor(input(at({ baseline: base }, { motorTemp: 3 }), HOT_DTERM));
    expect(why(r, 'R-FLT-DTERM-HOT-01')).toBe('floor');
    expect(sel(r)).toEqual([]);
    expect(r.autotune!.verdict).toBe('limit');
    expect(cfg.autotune.floorPct).toBe(85);
  });

  it('множитель фильтров ниже ×0.70 автотюн не ставит никогда', () => {
    const low = { ...FILTERS, simplified_dterm_filter_multiplier: 75 };
    const r = runAdvisor(input({ ...at({ baseline: low }, { motorTemp: 3 }), filters: { params: low, status: 'green', reason: 'ok' } }, HOT_DTERM));
    expect(why(r, 'R-FLT-DTERM-HOT-01')).toBe('floor');
  });

  it('нравится и моторы не горячие → ничего не трогаем, даже «можно ослабить»', () => {
    const r = runAdvisor(input(at({}, { feel: ['good'] })));
    expect(sel(r)).toEqual([]);
    expect(why(r, 'R-FLT-GYRO-RAISE-01')).toBe('happy');
    expect(r.advice.map((a) => a.id)).toContain('R-AT-HAPPY-01');
    expect(r.autotune!.verdict).toBe('done');
  });

  it('вялый, борт чистый → ослабить фильтр (живее), с предупреждением «потрогай моторы»', () => {
    const r = runAdvisor(input(at({}, { feel: ['sluggish'] })));
    expect(sel(r)).toEqual(['R-FLT-GYRO-RAISE-01']);
    expect(r.advice.find((a) => a.id === 'R-FLT-GYRO-RAISE-01')!.safety).toBe(true);
  });

  it('горячие моторы → ничего не ослабляем и D не поднимаем', () => {
    const r = runAdvisor(input(at({}, { motorTemp: 2 })));
    expect(why(r, 'R-FLT-GYRO-RAISE-01')).toBe('hot');
    const os = runAdvisor(input({ ...at({}, { motorTemp: 2 }), pid: pidWith(30) }));
    // перерегулирование: без автотюна — D вверх; горячо → отложено
    expect(runAdvisor(input({ pid: pidWith(30) })).advice.find((a) => a.id === 'R-PID-OVERSHOOT-01')!.inputs.way).toBe('d');
    expect(why(os, 'R-PID-OVERSHOOT-01')).toBe('hot');
  });
});

describe('автотюн: пропы', () => {
  it('побитые пропы → полёт не для настройки: ничего не меняем', () => {
    const r = runAdvisor(input(at({}, { props: 'damaged', motorTemp: 3 }), HOT_DTERM));
    expect(sel(r)).toEqual([]);
    expect(why(r, 'R-FLT-DTERM-HOT-01')).toBe('props');
    expect(r.autotune!.verdict).toBe('props');
    expect(r.advice[0].id === 'R-AT-PROPS-01' || r.advice.some((a) => a.id === 'R-AT-PROPS-01')).toBe(true);
    expect(Object.keys(r.to)).toEqual([]);
  });

  it('сколы → по шуму не решаем, но отклик (step) — как обычно', () => {
    const r = runAdvisor(input({ ...at({}, { props: 'chipped', motorTemp: 3 }), pid: pidWith(1, 1, true, 30) }, HOT_DTERM));
    expect(why(r, 'R-FLT-DTERM-HOT-01')).toBe('props');
    expect(sel(r)).toEqual(['R-PID-SLUGGISH-01']);
  });

  it('пилот сказал «целые», но шум до фильтров вырос на 80 % → подозрение, шумовые советы отложены', () => {
    const r = runAdvisor(input(at({ unfiltJumpPct: 80 }, { motorTemp: 3 }), HOT_DTERM));
    expect(r.advice.find((a) => a.id === 'R-AT-PROPS-SUSPECT-01')!.inputs.jump).toBe(80);
    expect(why(r, 'R-FLT-DTERM-HOT-01')).toBe('props');
    // рост в пределах нормы — не подозреваем
    expect(runAdvisor(input(at({ unfiltJumpPct: 20 }, { motorTemp: 3 }), HOT_DTERM)).advice.map((a) => a.id)).not.toContain('R-AT-PROPS-SUSPECT-01');
  });
});

describe('автотюн: откат', () => {
  const revert = { from: { simplified_gyro_filter_multiplier: 110 }, to: { simplified_gyro_filter_multiplier: 100 }, why: 'metric' as const, rules: ['R-FLT-GYRO-RAISE-01'] };

  it('откат — единственное изменение полёта', () => {
    const r = runAdvisor(input(at({ revert }, { motorTemp: 3 }), HOT_DTERM));
    expect(sel(r)).toEqual(['R-AT-REVERT-01']);
    expect(why(r, 'R-FLT-DTERM-HOT-01')).toBe('revert-only');
    expect(r.to).toEqual({ simplified_gyro_filter_multiplier: 100 });
    expect(r.autotune!.verdict).toBe('revert');
  });

  it('откат не ждёт механику (вернуться к тому, на чём летали, безопасно)', () => {
    const r = runAdvisor(input({ ...at({ revert }), motors: { satPct: 0.2, spreadPct: 5, desyncs: 2, airClips: 0, clipT: [] } }));
    expect(sel(r)).toEqual(['R-AT-REVERT-01']);
  });

  it('откатанное правило в этой серии больше не предлагается', () => {
    const r = runAdvisor(input(at({ avoid: ['R-FLT-GYRO-RAISE-01'] }, { feel: ['sluggish'] })));
    expect(why(r, 'R-FLT-GYRO-RAISE-01')).toBe('reverted');
    expect(sel(r)).toEqual(['R-FLT-DTERM-RAISE-01']);
  });

  it('у всех правил R-AT-* есть тексты', () => {
    for (const id of ['R-AT-PROPS-01', 'R-AT-PROPS-CHIPPED-01', 'R-AT-PROPS-SUSPECT-01', 'R-AT-REVERT-01', 'R-AT-HAPPY-01', 'R-AT-PROPWASH-01']) expect(T.adv.rules[id]?.title).toBeTruthy();
    for (const d of ['props', 'revert-only', 'reverted', 'not-hot', 'floor', 'hot', 'happy']) expect(T.adv.deferred[d]).toBeTruthy();
  });
});

// --- история серии: снимки ---
function snap(dt: string, cli: Record<string, number>, o: { unfilt?: number; os?: number; plan?: { rule: string; to: Record<string, number> } } = {}): SessionSnapshot {
  const ax = { rmsUnfilt: o.unfilt ?? 6, rmsFilt: 0.5, rmsDterm: 5, unfiltDb: null, filtDb: [], dtermDb: null };
  const step = { enough: true, activeS: 60, overshootPct: o.os ?? 10, delayMs: 8, settle: 1, trackRms: 10, spRms: 100, t: [], mean: [], std: [] };
  const from = o.plan ? Object.fromEntries(Object.keys(o.plan.to).map((k) => [k, cli[k]])) : {};
  return {
    v: SNAPSHOT_VERSION,
    source: { fileName: 'f.bbl', logIndex: 0, datetime: dt, durationS: 120, firmware: 'Betaflight 2026.6.1', fwCode: FW, board: 'B', craft: 'C', fs: 2000 },
    header: {}, cli,
    flight: { seconds: 100, thrHist: [0, 10, 30, 30, 20, 10, 0, 0, 0, 0], stickRms: [120, 110, 60], cellV: 3.9 },
    cards: [], noise: { df: 1, nyquist: 1000, axes: [ax, ax, ax], thr: { pct: [], seconds: [], filtRms: [], unfiltRms: null } },
    filters: { delay100: 2.5, delayD100: 4.5, match: [95, 95, 95], status: 'green' },
    pid: { axes: [step, step, { ...step, enough: false }] },
    advice: o.plan ? [{ id: o.plan.rule, version: 1, kind: 'tune', severity: 'yellow', selected: true, inputs: { rules: 'R-PID-OVERSHOOT-01' }, changes: o.plan.to, from }] : [],
    plan: o.plan ? { from, to: o.plan.to, ruleIds: [`${o.plan.rule}@1`], filters: null } : null,
  } as unknown as SessionSnapshot;
}

describe('автотюн: история серии', () => {
  const prev = snap('2026-10-01T10:00', { d_roll: 30 }, { os: 12, plan: { rule: 'R-PID-OVERSHOOT-01', to: { d_roll: 33 } } });

  it('изменение стоит на борту и по его цели стало хуже → откат к прошлым значениям', () => {
    const r = revertFor(prev, snap('2026-10-02T10:00', { d_roll: 33 }, { os: 20 }), ck(), 1)!;
    expect(r).toMatchObject({ why: 'metric', from: { d_roll: 33 }, to: { d_roll: 30 }, rules: ['R-PID-OVERSHOOT-01'] });
  });

  it('стало лучше → не откатываем; план не применён → не судим', () => {
    expect(revertFor(prev, snap('2026-10-02T10:00', { d_roll: 33 }, { os: 6 }), ck(), 1)).toBeNull();
    expect(revertFor(prev, snap('2026-10-02T10:00', { d_roll: 30 }, { os: 20 }), ck(), 1)).toBeNull();
  });

  it('пилот: «стало хуже» → откат, даже если цифры молчат', () => {
    expect(revertFor(prev, snap('2026-10-02T10:00', { d_roll: 33 }, { os: 12 }), ck({ feel: ['worse'] }), 1)!.why).toBe('pilot');
  });

  it('моторы стали горячими после подъёма D → откат; побитые пропы — не судим', () => {
    const cur = snap('2026-10-02T10:00', { d_roll: 33 }, { os: 12 });
    expect(revertFor(prev, cur, ck({ motorTemp: 3 }), 1)!.why).toBe('hot');
    expect(revertFor(prev, cur, ck({ motorTemp: 3 }), 2)).toBeNull();
    expect(revertFor(prev, snap('2026-10-02T10:00', { d_roll: 33 }, { os: 30 }), ck({ props: 'damaged' }), 1)).toBeNull();
  });

  it('откат отката не делаем (качели), откатанные правила собираются из серии', () => {
    const rv = snap('2026-10-02T10:00', { d_roll: 33 }, { plan: { rule: 'R-AT-REVERT-01', to: { d_roll: 30 } } });
    expect(revertFor(rv, snap('2026-10-03T10:00', { d_roll: 30 }, { os: 40 }), ck(), 1)).toBeNull();
    expect(revertedRules([prev, rv])).toEqual(['R-PID-OVERSHOOT-01']);
  });

  it('скачок шума до фильтров против прошлых полётов серии', () => {
    const refs = [snap('2026-10-01', {}, { unfilt: 6 }), snap('2026-10-02', {}, { unfilt: 7 }), snap('2026-10-03', {}, { unfilt: 6.5 })];
    expect(unfiltJump(refs, snap('2026-10-04', {}, { unfilt: 13 }))).toBe(100);
    expect(unfiltJump([], snap('2026-10-04', {}, { unfilt: 13 }))).toBeNull();
  });
});

// --- настоящие логи: тот же путь, что в воркере ---
async function analysis(file: string, index: number) {
  const r = fileReader(file);
  const st = await scanFile(r);
  r.close();
  const L = st.logs.find((l) => l.index === index)!;
  const end = L.crossesWrap && L.wrapBoundary ? L.wrapBoundary : L.end;
  return analyzeLog(buildContext(decodeLog(readRange(file, L.start, end - L.start))));
}

describe.skipIf(!hasFixture(SMALL_DUMP))('автотюн на логе 2026.6.1 №4 (два срыва)', () => {
  it('срывы — механика: настройки не меняем, вердикт «механика»; итог — в снимке сессии', async () => {
    const a = await analysis(SMALL_DUMP, 4);
    const board: BoardKnowledge = { autotune: { checkin: ck({ motorTemp: 1, feel: ['twitchy'] }), baseline: {}, iteration: 1 } };
    const adv = adviseLog(a, () => {}, board);
    expect(adv.autotune!.verdict).toBe('mechanics');
    expect(Object.keys(adv.to)).toEqual([]);
    const s = snapshotLog(a, adv, { fileName: 'x', logIndex: 4 });
    expect(s.autotune).toMatchObject({ verdict: 'mechanics', checkin: { props: 'ok', motorTemp: 1 } });
    expect(s.plan).toBeNull();
  });
});

describe.skipIf(!hasFixture(BIG_DUMP))('автотюн на логе 4.5.2 №3 (фристайл, D-term горячий)', () => {
  it('моторы тёплые → фильтр D-term не зажимаем; горячие → зажимаем на один шаг', async () => {
    const a = await analysis(BIG_DUMP, 3);
    const plain = adviseLog(a);
    expect(plain.to.simplified_dterm_filter_multiplier).toBe(125);
    const base = plain.from;
    const warm = adviseLog(a, () => {}, { autotune: { checkin: ck({ motorTemp: 1 }), baseline: base, iteration: 1 } });
    expect(warm.advice.find((x) => x.id === 'R-FLT-DTERM-HOT-01')!.deferred).toBe('not-hot');
    expect(warm.to.simplified_dterm_filter_multiplier).toBeUndefined();
    const hot = adviseLog(a, () => {}, { autotune: { checkin: ck({ motorTemp: 2 }), baseline: base, iteration: 1 } });
    expect(hot.to.simplified_dterm_filter_multiplier).toBe(125);
    expect(hot.advice.filter((x) => x.kind === 'tune' && x.selected)).toHaveLength(1);
  });
});

describe('автотюн: раунды и характер полёта (как у fpvpidtune.com)', () => {
  it('фильтры и PID в одном полёте — сначала раунд фильтров, PID ждёт', () => {
    // моторы горячие → зажать D-term (раунд 1); перерегулирование 30 % → PID (раунд 2)
    const r = runAdvisor(input({ pid: pidWith(30), ...at({}, { motorTemp: 2 }) }, HOT_DTERM));
    expect(sel(r)).toEqual(['R-FLT-DTERM-HOT-01']);
    expect(why(r, 'R-PID-OVERSHOOT-01')).toBe('stage');
    expect(r.autotune!.stage).toBe(1);
  });

  // фильтрам менять нечего (шум после фильтров между зелёным и красным) — раунд P:D
  const MID = { filt: [2, 2, 2] };
  it('фильтры в порядке — раунд P:D', () => {
    const r = runAdvisor(input({ pid: pidWith(30), ...at() }, MID));
    expect(sel(r)).toEqual(['R-PID-OVERSHOOT-01']);
    expect(r.autotune!.stage).toBe(2);
  });

  it('характер: «мягче» считает 12 % перерегулирования лишним, «резче» — нет', () => {
    const soft = runAdvisor(input({ pid: pidWith(12), ...at({ style: 'smoother' }) }, MID));
    expect(sel(soft)).toContain('R-PID-OVERSHOOT-01');
    const sharp = runAdvisor(input({ pid: pidWith(18), ...at({ style: 'sharper' }) }, MID));
    expect(sel(sharp)).not.toContain('R-PID-OVERSHOOT-01');
    expect(sharp.autotune!.style).toBe('sharper');
  });
});
